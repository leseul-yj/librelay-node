// vim: ts=4:sw=4:expandtab
/*
 * Implements EventTarget (with async support)
 * https://developer.mozilla.org/en-US/docs/Web/API/EventTarget
 */

const Event = require('./event');


class EventTarget {

    async dispatchEvent(ev) {
        if (!(ev instanceof Event)) {
            throw new TypeError('Expects an event');
        }
        if (!this._listeners) {
            return;
        }
        for (const callback of this._listeners[ev.type]) {
            try {
                await callback.call(this, ev);
            } catch(e) {
                console.error("Event Listener Exception", this, callback);
            }
        }
    }

    addEventListener(eventName, callback) {
        if (typeof eventName !== 'string') {
            throw new TypeError('First argument expects a string');
        }
        if (typeof callback !== 'function') {
            throw new TypeError('Second argument expects a function');
        }
        if (!this._listeners) {
            this._listeners = {};
        }
        if (!this._listeners[eventName]) {
            this._listeners[eventName] = [callback];
        } else {
            this._listeners[eventName].push(callback);
        }
    }

    removeEventListener(eventName, callback) {
        if (typeof eventName !== 'string') {
            throw new TypeError('First argument expects a string');
        }
        if (typeof callback !== 'function') {
            throw new TypeError('Second argument expects a function');
        }
        if (!this._listeners[eventName]) {
            return;
        }
        this._listeners[eventName] = this._listeners[eventName].filter(x => x !== callback);
    }
}

module.exports = EventTarget;
