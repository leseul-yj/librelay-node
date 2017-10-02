/*
 * vim: ts=4:sw=4:expandtab
 */

'use strict';

const Event = require('./event');
const EventTarget = require('./event_target');
const TextSecureServer = require('./textsecure_server');
const WebSocketResource = require('./websocket-resources');
const crypto = require('./crypto');
const errors = require('./errors');
const libsignal = require('libsignal');
const protobufs = require('./protobufs');
const queueAsync = require('./queue_async');
const storage = require('./storage');

const ENV_TYPES = protobufs.Envelope.lookup('Type').values;
const DATA_FLAGS = protobufs.DataMessage.lookup('Flags').values;


class MessageReceiver extends EventTarget {

    constructor(tss, addr, deviceId, signalingKey, noWebSocket) {
        super();
        console.assert(tss && addr && deviceId && signalingKey);
        this.tss = tss;
        this.addr = addr;
        this.deviceId = deviceId;
        this.signalingKey = signalingKey;
        if (!noWebSocket) {
            const url = this.tss.getMessageWebSocketURL();
            this.wsr = new WebSocketResource(url, {
                handleRequest: request => queueAsync(this, this.handleRequest.bind(this, request)),
                keepalive: {
                    path: '/v1/keepalive',
                    disconnect: true
                }
            });
            this.wsr.addEventListener('close', this.onSocketClose.bind(this));
            this.wsr.addEventListener('error', this.onSocketError.bind(this));
        }
    }

    static async factory(noWebSocket) {
        const tss = await TextSecureServer.factory();
        const addr = await storage.getState('addr');
        const deviceId = await storage.getState('deviceId');
        const signalingKey = await storage.getState('signalingKey');
        return new this(tss, addr, deviceId, signalingKey, noWebSocket);
    }

    connect() {
        this.wsr.connect();
    }

    close() {
        this.wsr.close();
    }

    async drain() {
        /* Pop messages directly from the messages API until it's empty. */
        if (this.wsr) {
            throw new TypeError("Fetch is invalid when websocket is in use");
        }
        let more;
        do {
            const data = await this.tss.request({call: 'messages'});
            more = data.more;
            const deleting = [];
            for (const envelope of data.messages) {
                if (envelope.content) {
                    envelope.content = Buffer.from(envelope.content, 'base64');
                }
                if (envelope.message) {
                    envelope.legacyMessage = Buffer.from(envelope.message, 'base64');
                }
                await this.handleEnvelope(envelope);
                deleting.push(this.tss.request({
                    call: 'messages',
                    httpType: 'DELETE',
                    urlParameters: `/${envelope.source}/${envelope.timestamp}`
                }));
            }
            await Promise.all(deleting);
        } while(more);
    }

    onSocketError(error) {
        console.error('Websocket error:', error);
    }

    async sleep(seconds) {
        await new Promise(resolve => {
            setTimeout(resolve, seconds * 1000);
        });
    }

    async onSocketClose(ev) {
        console.warn('Websocket closed:', ev.code, ev.reason || '');
        if (ev.code === 3000) {
            return;
        }
        // possible auth or network issue. Make a request to confirm
        let attempt = 0;
        while (true) {
            try {
                await this.tss.getDevices();
                break;
            } catch(e) {
                const backoff = Math.log1p(++attempt) * 30 * Math.random();
                console.error("Invalid network state:", e);
                const errorEvent = new Event('error');
                errorEvent.error = e;
                await this.dispatchEvent(errorEvent);
                console.info(`Will retry network in ${backoff} seconds (attempt ${attempt}).`);
                await this.sleep(backoff);
            }
        }
        this.connect();
    }

    async handleRequest(request) {
        if (request.path !== '/api/v1/message' || request.verb !== 'PUT') {
            console.error("Expected PUT /message instead of:", request);
            throw new Error('Invalid WebSocket resource received');
        }
        let envelope;
        try {
            const data = crypto.decryptWebsocketMessage(Buffer.from(request.body),
                                                        this.signalingKey);
            envelope = protobufs.Envelope.decode(data);
            envelope.timestamp = envelope.timestamp.toNumber();
        } catch(e) {
            request.respond(500, 'Bad encrypted websocket message');
            console.error("Error handling incoming message:", e);
            const ev = new Event('error');
            ev.error = e;
            await this.dispatchEvent(ev);
            throw e;
        }
        /* After this point, decoding errors are not the server's
         * fault and we should ACK them to prevent bad messages from
         * wedging us. */
        try {
            await this.handleEnvelope(envelope);
        } finally {
            request.respond(200, 'OK');
        }
    }

    async handleEnvelope(envelope, reentrant) {
        let handler;
        if (envelope.type === ENV_TYPES.RECEIPT) {
            handler = this.handleDeliveryReceipt;
        } else if (envelope.content) {
            handler = this.handleContentMessage;
        } else if (envelope.legacyMessage) {
            handler = this.handleLegacyMessage;
        } else {
            throw new Error('Received message with no content and no legacyMessage');
        }
        try {
            await handler.call(this, envelope);
        } catch(e) {
            if (e.name === 'MessageCounterError') {
                console.warn("Ignoring MessageCounterError for:", envelope);
                return;
            } else if (e instanceof errors.IncomingIdentityKeyError && !reentrant) {
                const ev = new Event('keychange');
                ev.addr = e.addr;
                ev.identityKey = e.identityKey;
                await this.dispatchEvent(ev);
                if (ev.accepted) {
                    envelope.keyChange = true;
                    return await this.handleEnvelope(envelope, /*reentrant*/ true);
                }
            } else if (e instanceof errors.TextSecureError) {
                console.warn("Supressing TextSecureError:", e);
            } else {
                const ev = new Event('error');
                ev.error = e;
                ev.proto = envelope;
                await this.dispatchEvent(ev);
                throw e;
            }
        }
    }

    async handleDeliveryReceipt(envelope) {
        const ev = new Event('receipt');
        ev.proto = envelope;
        await this.dispatchEvent(ev);
    }

    unpad(buf) {
        for (let i = buf.byteLength - 1; i >= 0; i--) {
            if (buf[i] == 0x80) {
                return buf.slice(0, i);
            } else if (buf[i] !== 0x00) {
                throw new Error('Invalid padding');
            }
        }
        return buf; // empty
    }

    async decrypt(envelope, ciphertext) {
        const addr = new libsignal.SignalProtocolAddress(envelope.source,
                                                         envelope.sourceDevice);
        const sessionCipher = new libsignal.SessionCipher(storage, addr);
        if (envelope.type === ENV_TYPES.CIPHERTEXT) {
            return this.unpad(await sessionCipher.decryptWhisperMessage(ciphertext));
        } else if (envelope.type === ENV_TYPES.PREKEY_BUNDLE) {
            return await this.decryptPreKeyWhisperMessage(ciphertext, sessionCipher, addr);
        }
        throw new Error("Unknown message type");
    }

    async decryptPreKeyWhisperMessage(ciphertext, sessionCipher, address) {
        try {
            return this.unpad(await sessionCipher.decryptPreKeyWhisperMessage(ciphertext));
        } catch(e) {
            if (e.message === 'Unknown identity key') {
                throw new errors.IncomingIdentityKeyError(address.toString(), ciphertext,
                                                          e.identityKey);
            }
            throw e;
        }
    }

    async handleSentMessage(sent, envelope) {
        if (sent.message.flags & DATA_FLAGS.END_SESSION) {
            await this.handleEndSession(sent.destination);
        }
        await this.processDecrypted(sent.message, this.addr);
        const ev = new Event('sent');
        ev.data = {
            source: envelope.source,
            sourceDevice: envelope.sourceDevice,
            timestamp: sent.timestamp.toNumber(),
            destination: sent.destination,
            message: sent.message
        };
        if (sent.expire) {
          ev.data.expirationStartTimestamp = sent.expire.toNumber();
        }
        await this.dispatchEvent(ev);
    }

    async handleDataMessage(message, envelope, content) {
        if (message.flags & DATA_FLAGS.END_SESSION) {
            await this.handleEndSession(envelope.source);
        }
        await this.processDecrypted(message, envelope.source);
        const ev = new Event('message');
        ev.data = {
            timestamp: envelope.timestamp,
            source: envelope.source,
            sourceDevice: envelope.sourceDevice,
            message,
            keyChange: envelope.keyChange
        };
        await this.dispatchEvent(ev);
    }

    async handleLegacyMessage(envelope) {
        const data = await this.decrypt(envelope, envelope.legacyMessage);
        const message = protobufs.DataMessage.decode(data);
        await this.handleDataMessage(message, envelope);
    }

    async handleContentMessage(envelope) {
        const data = await this.decrypt(envelope, envelope.content);
        const content = protobufs.Content.decode(data);
        if (content.syncMessage) {
            await this.handleSyncMessage(content.syncMessage, envelope, content);
        } else if (content.dataMessage) {
            await this.handleDataMessage(content.dataMessage, envelope, content);
        } else {
            throw new TypeError('Got content message with no dataMessage or syncMessage');
        }
    }

    async handleSyncMessage(message, envelope, content) {
        if (envelope.source !== this.addr) {
            throw new ReferenceError('Received sync message from another addr');
        }
        if (envelope.sourceDevice == this.deviceId) {
            throw new ReferenceError('Received sync message from our own device');
        }
        if (message.sent) {
            await this.handleSentMessage(message.sent, envelope);
        } else if (message.read && message.read.length) {
            await this.handleRead(message.read, envelope);
        } else if (message.contacts) {
            console.error("Deprecated contact sync message:", message, envelope, content);
            throw new TypeError('Deprecated contact sync message');
        } else if (message.groups) {
            console.error("Deprecated group sync message:", message, envelope, content);
            throw new TypeError('Deprecated group sync message');
        } else if (message.blocked) {
            this.handleBlocked(message.blocked, envelope);
        } else if (message.request) {
            console.error("Deprecated group request sync message:", message, envelope, content);
            throw new TypeError('Deprecated group request sync message');
        } else {
            console.error("Empty sync message:", message, envelope, content);
            throw new TypeError('Empty SyncMessage');
        }
    }

    async handleRead(read, envelope) {
        for (const x of read) {
            const ev = new Event('read');
            ev.timestamp = envelope.timestamp;
            ev.read = {
                timestamp: x.timestamp.toNumber(),
                sender: x.sender,
                source: envelope.source,
                sourceDevice: envelope.sourceDevice
            };
            await this.dispatchEvent(ev);
        }
    }

    handleBlocked(blocked) {
        throw new Error("UNSUPPORTRED");
    }

    async handleAttachment(attachment) {
        const encrypted = await this.tss.getAttachment(attachment.id.toString());
        attachment.data = await crypto.decryptAttachment(encrypted, attachment.key);
    }

    tryMessageAgain(from, ciphertext) {
        const address = libsignal.SignalProtocolAddress.fromString(from);
        const sessionCipher = new libsignal.SessionCipher(storage, address);
        console.warn('retrying prekey whisper message');
        return this.decryptPreKeyWhisperMessage(ciphertext, sessionCipher, address).then(function(plaintext) {
            const finalMessage = protobufs.DataMessage.decode(plaintext);
            let p = Promise.resolve();
            if ((finalMessage.flags & DATA_FLAGS.END_SESSION) == DATA_FLAGS.END_SESSION &&
                finalMessage.sync !== null) {
                    p = this.handleEndSession(address.getName());
            }
            return p.then(function() {
                return this.processDecrypted(finalMessage);
            }.bind(this));
        }.bind(this));
    }

    async handleEndSession(addr) {
        const deviceIds = await storage.getDeviceIds(addr);
        await Promise.all(deviceIds.map(deviceId => {
            const address = new libsignal.SignalProtocolAddress(addr, deviceId);
            const sessionCipher = new libsignal.SessionCipher(storage, address);
            console.warn('Closing session for', addr, deviceId);
            return sessionCipher.closeOpenSessionForDevice();
        }));
    }

    async processDecrypted(msg, source) {
        // Now that its decrypted, validate the message and clean it up for consumer processing
        // Note that messages may (generally) only perform one action and we ignore remaining fields
        // after the first action.
        if (msg.flags === null) {
            msg.flags = 0;
        }
        if (msg.expireTimer === null) {
            msg.expireTimer = 0;
        }
        if (msg.flags & DATA_FLAGS.END_SESSION) {
            return msg;
        }
        if (msg.group) {
            // We should blow up here very soon. XXX
            console.error("Legacy group message detected", msg);
        }
        if (msg.attachments) {
            await Promise.all(msg.attachments.map(this.handleAttachment.bind(this)));
        }
        return msg;
    }
}


module.exports = MessageReceiver;
