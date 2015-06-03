(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
"use strict";

/*
TODO:
- CS: complete register function (doing stages)
- Internal: rate limiting
- Identity server: linkEmail, authEmail, bindEmail, lookup3pid
- uploadContent (?)
*/

// expose the underlying request object so different environments can use
// different request libs (e.g. request or browser-request)
var request;
/**
 * The function used to perform HTTP requests.
 * @param {Function} r The request function which accepts (opts, callback)
 */
module.exports.request = function(r) {
    request = r;
};

/*
 * Construct a Matrix Client.
 * @param {Object} credentials The credentials for this client
 * @param {Object} config The config (if any) for this client.
 *  Valid config params include:
 *      noUserAgent: true // to avoid warnings whilst setting UA headers
 *      debug: true // to use console.err() style debugging from the lib
 * @param {Object} store The data store (if any) for this client.
 */
function MatrixClient(credentials, config, store) {
    if (typeof credentials === "string") {
        credentials = {
            "baseUrl": credentials
        };
    }
    var requiredKeys = [
        "baseUrl"
    ];
    for (var i = 0; i < requiredKeys.length; i++) {
        if (!credentials.hasOwnProperty(requiredKeys[i])) {
            throw new Error("Missing required key: " + requiredKeys[i]);
        }
    }
    if (config && config.noUserAgent) {
        HEADERS = undefined;
    }
    this.config = config;
    this.credentials = credentials;
    this.store = store;

    // track our position in the overall eventstream
    this.fromToken = undefined;
    this.clientRunning = false;
}
/**
 * The high-level Matrix Client class.
 */
module.exports.MatrixClient = MatrixClient;  // expose the class

/**
 * Create a new Matrix Client.
 * @param {Object} credentials The Matrix credentials to use.
 * @param {Object} config The config options for the client
 * @param {Store} store The type of store to use.
 * @return {MatrixClient} A new Matrix Client
 */
module.exports.createClient = function(credentials, config, store) {
    return new MatrixClient(credentials, config, store);
};

var CLIENT_PREFIX = "/_matrix/client/api/v1";
var CLIENT_V2_PREFIX = "/_matrix/client/v2_alpha";
var HEADERS = {
    "User-Agent": "matrix-js"
};

// Basic DAOs to abstract slightly from the line protocol and let the
// application customise events with domain-specific info
// (e.g. chat-specific semantics) if it so desires.

/*
 * Construct a Matrix Event object
 * @param {Object} event The raw event to be wrapped in this DAO
 */
function MatrixEvent(event) {
    this.event = event || {};
}

/**
 * An event from Matrix.
 */
module.exports.MatrixEvent = MatrixEvent;

MatrixEvent.prototype = {
    getId: function() {
        return this.event.event_id;
    },
    getSender: function() {
        return this.event.user_id;
    },
    getType: function() {
        return this.event.type;
    },
    getRoomId: function() {
        return this.event.room_id;
    },
    getTs: function() {
        return this.event.ts;
    },
    getContent: function() {
        return this.event.content;
    },
    isState: function() {
        return this.event.state_key !== undefined;
    },
};

function MatrixInMemoryStore() {
    this.rooms = {
        // state: { },
        // timeline: [ ],
    };

    this.presence = {
        // presence objects keyed by userId
    };
}

/**
 * An in-memory store for Matrix.
 */
module.exports.MatrixInMemoryStore = MatrixInMemoryStore;

// XXX: this is currently quite procedural - we could possibly pass back
// models of Rooms, Users, Events, etc instead.
MatrixInMemoryStore.prototype = {

    /*
     * Add an array of one or more state MatrixEvents into the store, overwriting
     * any existing state with the same {room, type, stateKey} tuple.
     */
    setStateEvents: function(stateEvents) {
        // we store stateEvents indexed by room, event type and state key.
        for (var i = 0; i < stateEvents.length; i++) {
            var event = stateEvents[i].event;
            var roomId = event.room_id;
            if (this.rooms[roomId] === undefined) {
                this.rooms[roomId] = {};
            }
            if (this.rooms[roomId].state === undefined) {
                this.rooms[roomId].state = {};
            }
            if (this.rooms[roomId].state[event.type] === undefined) {
                this.rooms[roomId].state[event.type] = {};
            }
            this.rooms[roomId].state[event.type][event.state_key] = stateEvents[i];
        }
    },

    /*
     * Add a single state MatrixEvents into the store, overwriting
     * any existing state with the same {room, type, stateKey} tuple.
     */
    setStateEvent: function(stateEvent) {
        this.setStateEvents([stateEvent]);
    },

    /*
     * Return a list of MatrixEvents from the store
     * @param {String} roomId the Room ID whose state is to be returned
     * @param {String} type the type of the state events to be returned (optional)
     * @param {String} stateKey the stateKey of the state events to be returned
     *                 (optional, requires type to be specified)
     * @return {MatrixEvent[]} an array of MatrixEvents from the store,
     * filtered by roomid, type and state key.
     */
    getStateEvents: function(roomId, type, stateKey) {
        var stateEvents = [];
        if (stateKey === undefined && type === undefined) {
            for (type in this.rooms[roomId].state) {
                if (this.rooms[roomId].state.hasOwnProperty(type)) {
                    for (stateKey in this.rooms[roomId].state[type]) {
                        if (this.rooms[roomId].state[type].hasOwnProperty(stateKey)) {
                            stateEvents.push(
                                this.rooms[roomId].state[type][stateKey]
                            );
                        }
                    }
                }
            }
            return stateEvents;
        }
        else if (stateKey === undefined) {
            for (stateKey in this.rooms[roomId].state[type]) {
                if (this.rooms[roomId].state[type].hasOwnProperty(stateKey)) {
                    stateEvents.push(this.rooms[roomId].state[type][stateKey]);
                }
            }
            return stateEvents;
        }
        else {
            return [this.rooms[roomId].state[type][stateKey]];
        }
    },

    /*
     * Return a single state MatrixEvent from the store for the given roomId
     * and type.
     * @param {String} roomId the Room ID whose state is to be returned
     * @param {String} type the type of the state events to be returned
     * @param {String} stateKey the stateKey of the state events to be returned
     * @return {MatrixEvent} a single MatrixEvent from the store, filtered
     * by roomid, type and state key.
     */
    getStateEvent: function(roomId, type, stateKey) {
        return this.rooms[roomId].state[type][stateKey];
    },

    /*
     * Adds a list of arbitrary MatrixEvents into the store.
     * If the event is a state event, it is also updates state.
     */
    setEvents: function(events) {
        for (var i = 0; i < events.length; i++) {
            var event = events[i].event;
            if (event.type === "m.presence") {
                this.setPresenceEvents([events[i]]);
                continue;
            }
            var roomId = event.room_id;
            if (this.rooms[roomId] === undefined) {
                this.rooms[roomId] = {};
            }
            if (this.rooms[roomId].timeline === undefined) {
                this.rooms[roomId].timeline = [];
            }
            if (event.state_key !== undefined) {
                this.setStateEvents([events[i]]);
            }
            this.rooms[roomId].timeline.push(events[i]);
        }
    },

    /*
     * Get the timeline of events for a given room
     * TODO: ordering!
     */
    getEvents: function(roomId) {
        return this.room[roomId].timeline;
    },

    setPresenceEvents: function(presenceEvents) {
        for (var i = 0; i < presenceEvents.length; i++) {
            var matrixEvent = presenceEvents[i];
            this.presence[matrixEvent.event.user_id] = matrixEvent;
        }
    },

    getPresenceEvents: function(userId) {
        return this.presence[userId];
    },

    getRoomList: function() {
        var roomIds = [];
        for (var roomId in this.rooms) {
            if (this.rooms.hasOwnProperty(roomId)) {
                roomIds.push(roomId);
            }
        }
        return roomIds;
    },

    // TODO
    //setMaxHistoryPerRoom: function(maxHistory) {},

    // TODO
    //reapOldMessages: function() {},
};

MatrixClient.prototype = {
    isLoggedIn: function() {
        return this.credentials.accessToken !== undefined &&
               this.credentials.userId !== undefined;
    },

    // Higher level APIs
    // =================

    // TODO: stuff to handle:
    //   local echo
    //   event dup suppression? - apparently we should still be doing this
    //   tracking current display name / avatar per-message
    //   pagination
    //   re-sending (including persisting pending messages to be sent)
    //   - Need a nice way to callback the app for arbitrary events like
    //     displayname changes
    //   due to ambiguity (or should this be on a chat-specific layer)?
    //   reconnect after connectivity outages

    /*
     * Helper method for retrieving the name of a room suitable for display
     * in the UI
     * TODO: in future, this should be being generated serverside.
     * @param {String} roomId ID of room whose name is to be resolved
     * @return {String} human-readable label for room.
     */
    getFriendlyRoomName: function(roomId) {
        // we need a store to track the inputs for calculating room names
        if (!this.store) {
            return roomId;
        }

        // check for an alias, if any. for now, assume first alias is the
        // official one.
        var alias;
        var mRoomAliases = this.store.getStateEvents(roomId, 'm.room.aliases')[0];
        if (mRoomAliases) {
            alias = mRoomAliases.event.content.aliases[0];
        }

        var mRoomName = this.store.getStateEvent(roomId, 'm.room.name', '');
        if (mRoomName) {
            return mRoomName.event.content.name + (alias ? " (" + alias + ")" : "");
        }
        else if (alias) {
            return alias;
        }
        else {
            var userId = this.credentials.userId;
            var members = this.store.getStateEvents(roomId, 'm.room.member')
                .filter(function(event) {
                    return event.event.user_id !== userId;
                });

            if (members.length === 0) {
                return "Unknown";
            }
            else if (members.length == 1) {
                return (
                    members[0].event.content.displayname ||
                        members[0].event.user_id
                );
            }
            else if (members.length == 2) {
                return (
                    (members[0].event.content.displayname ||
                        members[0].event.user_id) +
                    " and " +
                    (members[1].event.content.displayname ||
                        members[1].event.user_id)
                );
            }
            else {
                return (
                    (members[0].event.content.displayname ||
                        members[0].event.user_id) +
                    " and " +
                    (members.length - 1) + " others"
                );
            }
        }
    },

    /*
     * Helper method for retrieving the name of a user suitable for display
     * in the UI in the context of a room - i.e. disambiguating from any
     * other users in the room.
     * XXX: This could perhaps also be generated serverside, perhaps by just passing
     * a 'disambiguate' flag down on membership entries which have ambiguous
     * displaynames?
     * @param {String} userId ID of the user whose name is to be resolved
     * @param {String} roomId ID of room to be used as the context for
     * resolving the name.
     * @return {String} human-readable name of the user.
     */
    getFriendlyDisplayName: function(userId, roomId) {
        // we need a store to track the inputs for calculating display names
        if (!this.store) { return userId; }

        var displayName;
        var memberEvent = this.store.getStateEvent(roomId, 'm.room.member', userId);
        if (memberEvent && memberEvent.event.content.displayname) {
            displayName = memberEvent.event.content.displayname;
        }
        else {
            return userId;
        }

        var members = this.store.getStateEvents(roomId, 'm.room.member')
            .filter(function(event) {
                return event.event.content.displayname === displayName;
            });

        if (members.length > 1) {
            return displayName + " (" + userId + ")";
        }
        else {
            return displayName;
        }
    },

    /*
     * High level helper method to call initialSync, emit the resulting events,
     * and then start polling the eventStream for new events.
     * @param {function} callback Callback invoked whenever new event are available
     * @param {Number} historyLen amount of historical timeline events to
     * emit during from the initial sync.
     */
    startClient: function(callback, historyLen) {
        historyLen = historyLen || 12;

        var self = this;
        if (!this.fromToken) {
            this.initialSync(historyLen, function(err, data) {
                if (err) {
                    if (this.config && this.config.debug) {
                        console.error(
                            "startClient error on initialSync: %s",
                            JSON.stringify(err)
                        );
                    }
                    callback(err);
                } else {
                    var events = [];
                    var i, j;
                    for (i = 0; i < data.presence.length; i++) {
                        events.push(new MatrixEvent(data.presence[i]));
                    }
                    for (i = 0; i < data.rooms.length; i++) {
                        for (j = 0; j < data.rooms[i].state.length; j++) {
                            events.push(new MatrixEvent(data.rooms[i].state[j]));
                        }
                        for (j = 0; j < data.rooms[i].messages.chunk.length; j++) {
                            events.push(
                                new MatrixEvent(data.rooms[i].messages.chunk[j])
                            );
                        }
                    }
                    callback(undefined, events, false);
                    self.clientRunning = true;
                    self._pollForEvents(callback);
                }
            });
        }
        else {
            this._pollForEvents(callback);
        }
    },

    _pollForEvents: function(callback) {
        var self = this;
        if (!this.clientRunning) {
            return;
        }
        this.eventStream(this.fromToken, 30000, function(err, data) {
            if (err) {
                if (this.config && this.config.debug) {
                    console.error(
                        "error polling for events via eventStream: %s",
                        JSON.stringify(err)
                    );
                }
                callback(err);
                // retry every few seconds
                // FIXME: this should be exponential backoff with an option to nudge
                setTimeout(function() {
                    self._pollForEvents(callback);
                }, 2000);
            } else {
                var events = [];
                for (var j = 0; j < data.chunk.length; j++) {
                    events.push(new MatrixEvent(data.chunk[j]));
                }
                callback(undefined, events, true);
                self._pollForEvents(callback);
            }
        });
    },

    /*
     * High level helper method to stop the client from polling and allow a
     * clean shutdown.
     */
    stopClient: function() {
        this.clientRunning = false;
    },

    // Room operations
    // ===============

    createRoom: function(options, callback) {
        // valid options include: room_alias_name, visibility, invite
        return this._doAuthedRequest(
            callback, "POST", "/createRoom", undefined, options
        );
    },

    joinRoom: function(roomIdOrAlias, callback) {
        var path = encodeUri("/join/$roomid", { $roomid: roomIdOrAlias});
        return this._doAuthedRequest(callback, "POST", path, undefined, {});
    },

    setRoomName: function(roomId, name, callback) {
        return this.sendStateEvent(roomId, "m.room.name", {name: name},
                                   undefined, callback);
    },

    setRoomTopic: function(roomId, topic, callback) {
        return this.sendStateEvent(roomId, "m.room.topic", {topic: topic},
                                   undefined, callback);
    },

    setPowerLevel: function(roomId, userId, powerLevel, event, callback) {
        var content = {
            users: {}
        };
        if (event && event.type == "m.room.power_levels") {
            content = event.content;
        }
        content.users[userId] = powerLevel;
        var path = encodeUri("/rooms/$roomId/state/m.room.power_levels", {
            $roomId: roomId
        });
        return this._doAuthedRequest(
            callback, "PUT", path, undefined, content
        );
    },

    getStateEvent: function(roomId, eventType, stateKey, callback) {
        var pathParams = {
            $roomId: roomId,
            $eventType: eventType,
            $stateKey: stateKey
        };
        var path = encodeUri("/rooms/$roomId/state/$eventType", pathParams);
        if (stateKey !== undefined) {
            path = encodeUri(path + "/$stateKey", pathParams);
        }
        return this._doAuthedRequest(
            callback, "GET", path
        );
    },

    sendStateEvent: function(roomId, eventType, content, stateKey, 
                             callback) {
        var pathParams = {
            $roomId: roomId,
            $eventType: eventType,
            $stateKey: stateKey
        };
        var path = encodeUri("/rooms/$roomId/state/$eventType", pathParams);
        if (stateKey !== undefined) {
            path = encodeUri(path + "/$stateKey", pathParams);
        }
        return this._doAuthedRequest(
            callback, "PUT", path, undefined, content
        );
    },

    sendEvent: function(roomId, eventType, content, txnId, callback) {
        if (isFunction(txnId)) { callback = txnId; txnId = undefined; }

        if (!txnId) {
            txnId = "m" + new Date().getTime();
        }

        var path = encodeUri("/rooms/$roomId/send/$eventType/$txnId", {
            $roomId: roomId,
            $eventType: eventType,
            $txnId: txnId
        });
        return this._doAuthedRequest(
            callback, "PUT", path, undefined, content
        );
    },

    sendMessage: function(roomId, content, txnId, callback) {
        if (isFunction(txnId)) { callback = txnId; txnId = undefined; }
        return this.sendEvent(
            roomId, "m.room.message", content, txnId, callback
        );
    },

    sendTextMessage: function(roomId, body, txnId, callback) {
        var content = {
             msgtype: "m.text",
             body: body
        };
        return this.sendMessage(roomId, content, txnId, callback);
    },

    sendEmoteMessage: function(roomId, body, txnId, callback) {
        var content = {
             msgtype: "m.emote",
             body: body
        };
        return this.sendMessage(roomId, content, txnId, callback);
    },

    sendImageMessage: function(roomId, url, info, text, callback) {
        if (isFunction(text)) { callback = text; text = undefined; }
        if (!text) { text = "Image"; }
        var content = {
             msgtype: "m.image",
             url: url,
             info: info,
             body: text
        };
        return this.sendMessage(roomId, content, callback);
    },

    sendHtmlMessage: function(roomId, body, htmlBody, callback) {
        var content = {
            msgtype: "m.text",
            format: "org.matrix.custom.html",
            body: body,
            formatted_body: htmlBody
        };
        return this.sendMessage(roomId, content, callback);
    },

    sendTyping: function(roomId, isTyping, timeoutMs, callback) {
        var path = encodeUri("/rooms/$roomId/typing/$userId", {
            $roomId: roomId,
            $userId: this.credentials.userId
        });
        var data = {
            typing: isTyping
        };
        if (isTyping) {
            data.timeout = timeoutMs ? timeoutMs : 20000;
        }
        return this._doAuthedRequest(
            callback, "PUT", path, undefined, data
        );
    },

    redactEvent: function(roomId, eventId, callback) {
        var path = encodeUri("/rooms/$roomId/redact/$eventId", {
            $roomId: roomId,
            $eventId: eventId
        });
        return this._doAuthedRequest(callback, "POST", path, undefined, {});
    },

    invite: function(roomId, userId, callback) {
        return this._membershipChange(roomId, userId, "invite", undefined,
            callback);
    },

    leave: function(roomId, callback) {
        return this._membershipChange(roomId, undefined, "leave", undefined,
            callback);
    },

    ban: function(roomId, userId, reason, callback) {
        return this._membershipChange(roomId, userId, "ban", reason,
            callback);
    },

    unban: function(roomId, userId, callback) {
        // unbanning = set their state to leave
        return this._setMembershipState(
            roomId, userId, "leave", undefined, callback
        );
    },

    kick: function(roomId, userId, reason, callback) {
        return this._setMembershipState(
            roomId, userId, "leave", reason, callback
        );
    },

    _setMembershipState: function(roomId, userId, membershipValue, reason, 
                            callback) {
        if (isFunction(reason)) { callback = reason; reason = undefined; }

        var path = encodeUri(
            "/rooms/$roomId/state/m.room.member/$userId",
            { $roomId: roomId, $userId: userId}
        );

        return this._doAuthedRequest(callback, "PUT", path, undefined, {
            membership: membershipValue,
            reason: reason
        });
    },

    _membershipChange: function(roomId, userId, membership, reason, 
                                callback) {
        if (isFunction(reason)) { callback = reason; reason = undefined; }

        var path = encodeUri("/rooms/$room_id/$membership", {
            $room_id: roomId,
            $membership: membership
        });
        return this._doAuthedRequest(
            callback, "POST", path, undefined, {
                user_id: userId,  // may be undefined e.g. on leave
                reason: reason
            }
        );
    },

    // Profile operations
    // ==================

    getProfileInfo: function(userId, info, callback) {
        if (isFunction(info)) { callback = info; info = undefined; }

        var path = info ?
        encodeUri("/profile/$userId/$info",
                 { $userId: userId, $info: info }) :
        encodeUri("/profile/$userId",
                 { $userId: userId });
        return this._doAuthedRequest(callback, "GET", path);
    },

    setProfileInfo: function(info, data, callback) {
        var path = encodeUri("/profile/$userId/$info", {
            $userId: this.credentials.userId,
            $info: info
        });
        return this._doAuthedRequest(
            callback, "PUT", path, undefined, data
        );
    },

    setDisplayName: function(name, callback) {
        return this.setProfileInfo(
            "displayname", { displayname: name }, callback
        );
    },

    setAvatarUrl: function(url, callback) {
        return this.setProfileInfo(
            "avatar_url", { avatar_url: url }, callback
        );
    },

    getThreePids: function(creds, bind, callback) {
        var path = "/account/3pid";
        return this._doAuthedV2Request(
            callback, "GET", path, undefined, undefined
        );
    },

    addThreePid: function(creds, bind, callback) {
        var path = "/account/3pid";
        var data = {
            'threePidCreds': creds,
            'bind': bind
        };
        return this._doAuthedV2Request(
            callback, "POST", path, undefined, data
        );
    },

    setPresence: function(presence, callback) {
        var path = encodeUri("/presence/$userId/status", {
            $userId: this.credentials.userId
        });
        var validStates = ["offline", "online", "unavailable"];
        if (validStates.indexOf(presence) == -1) {
            throw new Error("Bad presence value: " + presence);
        }
        var content = {
            presence: presence
        };
        return this._doAuthedRequest(
            callback, "PUT", path, undefined, content
        );
    },

    // Public (non-authed) operations
    // ==============================

    publicRooms: function(callback) {
        return this._doRequest(callback, "GET", "/publicRooms");
    },

    registerFlows: function(callback) {
        return this._doRequest(callback, "GET", "/register");
    },

    loginFlows: function(callback) {
        return this._doRequest(callback, "GET", "/login");
    },

    resolveRoomAlias: function(roomAlias, callback) {
        var path = encodeUri("/directory/room/$alias", {$alias: roomAlias});
        return this._doRequest(callback, "GET", path);
    },

    // Syncing operations
    // ==================

    initialSync: function(limit, callback) {
        var params = {
            limit: limit
        };
        var self = this;
        return this._doAuthedRequest(
            function(err, data) {
                if (self.store) {
                    var eventMapper = function(event) {
                        return new MatrixEvent(event);
                    };
                    // intercept the results and put them into our store
                    self.store.setPresenceEvents(
                        map(data.presence, eventMapper)
                    );
                    for (var i = 0; i < data.rooms.length; i++) {
                        self.store.setStateEvents(
                            map(data.rooms[i].state, eventMapper)
                        );
                        self.store.setEvents(
                            map(data.rooms[i].messages.chunk, eventMapper)
                        );
                    }
                }
                if (data) {
                    self.fromToken = data.end;
                }
                callback(err, data); // continue with original callback
            }, "GET", "/initialSync", params
        );
    },

    roomInitialSync: function(roomId, limit, callback) {
        if (isFunction(limit)) { callback = limit; limit = undefined; }
        var path = encodeUri("/rooms/$roomId/initialSync",
            {$roomId: roomId}
        );
        if (!limit) {
            limit = 30;
        }
        return this._doAuthedRequest(
            callback, "GET", path, { limit: limit }
        );
    },

    roomState: function(roomId, callback) {
        var path = encodeUri("/rooms/$roomId/state", {$roomId: roomId});
        return this._doAuthedRequest(callback, "GET", path);
    },

    scrollback: function(roomId, from, limit, callback) {
        if (isFunction(limit)) { callback = limit; limit = undefined; }
        var path = encodeUri("/rooms/$roomId/messages", {$roomId: roomId});
        if (!limit) {
            limit = 30;
        }
        var params = {
            from: from,
            limit: limit,
            dir: 'b'
        };
        return this._doAuthedRequest(callback, "GET", path, params);
    },

    eventStream: function(from, timeout, callback) {
        if (isFunction(timeout)) { callback = timeout; timeout = undefined;}
        if (!timeout) {
            timeout = 30000;
        }

        var params = {
            from: from,
            timeout: timeout
        };
        var self = this;
        return this._doAuthedRequest(
            function(err, data) {
                if (self.store) {
                    self.store.setEvents(map(data.chunk,
                        function(event) {
                            return new MatrixEvent(event);
                        }
                    ));
                }
                if (data) {
                    self.fromToken = data.end;
                }
                callback(err, data); // continue with original callback
            }, "GET", "/events", params);
    },

    // Registration/Login operations
    // =============================

    login: function(loginType, data, callback) {
        data.type = loginType;
        return this._doAuthedRequest(
            callback, "POST", "/login", undefined, data
        );
        // XXX: surely we should store the results of this into our credentials
    },

    register: function(loginType, data, callback) {
        data.type = loginType;
        return this._doAuthedRequest(
            callback, "POST", "/register", undefined, data
        );
    },

    loginWithPassword: function(user, password, callback) {
        return this.login("m.login.password", {
            user: user,
            password: password
        }, callback);
    },

    // Push operations
    // ===============

    pushRules: function(callback) {
        return this._doAuthedRequest(callback, "GET", "/pushrules/");
    },

    addPushRule: function(scope, kind, ruleId, body, callback) {
        // NB. Scope not uri encoded because devices need the '/'
        var path = encodeUri("/pushrules/" + scope + "/$kind/$ruleId", {
            $kind: kind,
            $ruleId: ruleId
        });
        return this._doAuthedRequest(
            callback, "PUT", path, undefined, body
        );
    },

    deletePushRule: function(scope, kind, ruleId, callback) {
        // NB. Scope not uri encoded because devices need the '/'
        var path = encodeUri("/pushrules/" + scope + "/$kind/$ruleId", {
            $kind: kind,
            $ruleId: ruleId
        });
        return this._doAuthedRequest(callback, "DELETE", path);
    },

    // VoIP operations
    // ===============

    turnServer: function(callback) {
        return this._doAuthedRequest(callback, "GET", "/voip/turnServer");
    },

    // URI functions
    // =============

    getHttpUriForMxc: function(mxc, width, height, resizeMethod) {
        if (typeof mxc !== "string" || !mxc) {
            return mxc;
        }
        if (mxc.indexOf("mxc://") !== 0) {
            return mxc;
        }
        var serverAndMediaId = mxc.slice(6); // strips mxc://
        var prefix = "/_matrix/media/v1/download/";
        var params = {};

        if (width) {
            params.width = width;
        }
        if (height) {
            params.height = height;
        }
        if (resizeMethod) {
            params.method = resizeMethod;
        }
        if (Object.keys(params).length > 0) {
            // these are thumbnailing params so they probably want the
            // thumbnailing API...
            prefix = "/_matrix/media/v1/thumbnail/";
        }

        var fragmentOffset = serverAndMediaId.indexOf("#"),
            fragment = "";
        if (fragmentOffset >= 0) {
            fragment = serverAndMediaId.substr(fragmentOffset);
            serverAndMediaId = serverAndMediaId.substr(0, fragmentOffset);
        }
        return this.credentials.baseUrl + prefix + serverAndMediaId +
            (Object.keys(params).length === 0 ? "" :
            ("?" + encodeParams(params))) + fragment;
    },

    getIdenticonUri: function(identiconString, width, height) {
        if (!identiconString) {
            return;
        }
        if (!width) { width = 96; }
        if (!height) { height = 96; }
        var params = {
            width: width,
            height: height
        };

        var path = encodeUri("/_matrix/media/v1/identicon/$ident", {
            $ident: identiconString
        });
        return this.credentials.baseUrl + path +
            (Object.keys(params).length === 0 ? "" :
                ("?" + encodeParams(params)));
    },

    /**
     * Get the content repository url with query parameters.
     * @return {Object} An object with a 'base', 'path' and 'params' for
     * base URL, path and query parameters respectively.
     */
    getContentUri: function() {
        var params = {
            access_token: this.credentials.accessToken
        };
        return {
            base: this.credentials.baseUrl,
            path: "/_matrix/media/v1/upload",
            params: params
        };
    },

    // Internals
    // =========

    _doAuthedRequest: function(callback, method, path, params, data) {
        if (!params) { params = {}; }
        params.access_token = this.credentials.accessToken;
        return this._doRequest(callback, method, path, params, data);
    },

    _doAuthedV2Request: function(callback, method, path, params, data) {
        if (!params) { params = {}; }
        params.access_token = this.credentials.accessToken;
        return this._doV2Request(callback, method, path, params, data);
    },

    _doRequest: function(callback, method, path, params, data) {
        var fullUri = this.credentials.baseUrl + CLIENT_PREFIX + path;
        if (!params) { params = {}; }
        return this._request(callback, method, fullUri, params, data);
    },

    _doV2Request: function(callback, method, path, params, data) {
        var fullUri = this.credentials.baseUrl + CLIENT_V2_PREFIX + path;
        if (!params) { params = {}; }
        return this._request(callback, method, fullUri, params, data);
    },

    _request: function(callback, method, uri, params, data) {
        if (callback !== undefined && !isFunction(callback)) {
            throw Error("Expected callback to be a function");
        }

        return request(
        {
            uri: uri,
            method: method,
            withCredentials: false,
            qs: params,
            body: data,
            json: true,
            headers: HEADERS,
            _matrix_credentials: this.credentials
        },
        requestCallback(callback)
        );
    }
};

var encodeUri = function(pathTemplate, variables) {
    for (var key in variables) {
        if (!variables.hasOwnProperty(key)) { continue; }
        pathTemplate = pathTemplate.replace(
            key, encodeURIComponent(variables[key])
        );
    }
    return pathTemplate;
};

// avoiding deps on jquery and co
var encodeParams = function(params) {
    var qs = "";
    for (var key in params) {
        if (!params.hasOwnProperty(key)) { continue; }
        qs += "&" + encodeURIComponent(key) + "=" +
                encodeURIComponent(params[key]);
    }
    return qs.substring(1);
};

var requestCallback = function(userDefinedCallback) {
    if (!userDefinedCallback) {
        return undefined;
    }
    return function(err, response, body) {
        if (err) {
            return userDefinedCallback(err);
        }
        if (response.statusCode >= 400) {
            return userDefinedCallback(body);
        }
        else {
            userDefinedCallback(null, body);
        }
    };
};

var isFunction = function(value) {
    return Object.prototype.toString.call(value) == "[object Function]";
};

var map = function(array, fn) {
    var results = new Array(array.length);
    for (var i = 0; i < array.length; i++) {
        results[i] = fn(array[i]);
    }
    return results;
};

},{}],2:[function(require,module,exports){
// Browser Request
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// UMD HEADER START 
(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define([], factory);
    } else if (typeof exports === 'object') {
        // Node. Does not work with strict CommonJS, but
        // only CommonJS-like enviroments that support module.exports,
        // like Node.
        module.exports = factory();
    } else {
        // Browser globals (root is window)
        root.returnExports = factory();
  }
}(this, function () {
// UMD HEADER END

var XHR = XMLHttpRequest
if (!XHR) throw new Error('missing XMLHttpRequest')
request.log = {
  'trace': noop, 'debug': noop, 'info': noop, 'warn': noop, 'error': noop
}

var DEFAULT_TIMEOUT = 3 * 60 * 1000 // 3 minutes

//
// request
//

function request(options, callback) {
  // The entry-point to the API: prep the options object and pass the real work to run_xhr.
  if(typeof callback !== 'function')
    throw new Error('Bad callback given: ' + callback)

  if(!options)
    throw new Error('No options given')

  var options_onResponse = options.onResponse; // Save this for later.

  if(typeof options === 'string')
    options = {'uri':options};
  else
    options = JSON.parse(JSON.stringify(options)); // Use a duplicate for mutating.

  options.onResponse = options_onResponse // And put it back.

  if (options.verbose) request.log = getLogger();

  if(options.url) {
    options.uri = options.url;
    delete options.url;
  }

  if(!options.uri && options.uri !== "")
    throw new Error("options.uri is a required argument");

  if(typeof options.uri != "string")
    throw new Error("options.uri must be a string");

  var unsupported_options = ['proxy', '_redirectsFollowed', 'maxRedirects', 'followRedirect']
  for (var i = 0; i < unsupported_options.length; i++)
    if(options[ unsupported_options[i] ])
      throw new Error("options." + unsupported_options[i] + " is not supported")

  options.callback = callback
  options.method = options.method || 'GET';
  options.headers = options.headers || {};
  options.body    = options.body || null
  options.timeout = options.timeout || request.DEFAULT_TIMEOUT

  if(options.headers.host)
    throw new Error("Options.headers.host is not supported");

  if(options.json) {
    options.headers.accept = options.headers.accept || 'application/json'
    if(options.method !== 'GET')
      options.headers['content-type'] = 'application/json'

    if(typeof options.json !== 'boolean')
      options.body = JSON.stringify(options.json)
    else if(typeof options.body !== 'string')
      options.body = JSON.stringify(options.body)
  }
  
  //BEGIN QS Hack
  var serialize = function(obj) {
    var str = [];
    for(var p in obj)
      if (obj.hasOwnProperty(p)) {
        str.push(encodeURIComponent(p) + "=" + encodeURIComponent(obj[p]));
      }
    return str.join("&");
  }
  
  if(options.qs){
    var qs = (typeof options.qs == 'string')? options.qs : serialize(options.qs);
    if(options.uri.indexOf('?') !== -1){ //no get params
        options.uri = options.uri+'&'+qs;
    }else{ //existing get params
        options.uri = options.uri+'?'+qs;
    }
  }
  //END QS Hack
  
  //BEGIN FORM Hack
  var multipart = function(obj) {
    //todo: support file type (useful?)
    var result = {};
    result.boundry = '-------------------------------'+Math.floor(Math.random()*1000000000);
    var lines = [];
    for(var p in obj){
        if (obj.hasOwnProperty(p)) {
            lines.push(
                '--'+result.boundry+"\n"+
                'Content-Disposition: form-data; name="'+p+'"'+"\n"+
                "\n"+
                obj[p]+"\n"
            );
        }
    }
    lines.push( '--'+result.boundry+'--' );
    result.body = lines.join('');
    result.length = result.body.length;
    result.type = 'multipart/form-data; boundary='+result.boundry;
    return result;
  }
  
  if(options.form){
    if(typeof options.form == 'string') throw('form name unsupported');
    if(options.method === 'POST'){
        var encoding = (options.encoding || 'application/x-www-form-urlencoded').toLowerCase();
        options.headers['content-type'] = encoding;
        switch(encoding){
            case 'application/x-www-form-urlencoded':
                options.body = serialize(options.form).replace(/%20/g, "+");
                break;
            case 'multipart/form-data':
                var multi = multipart(options.form);
                //options.headers['content-length'] = multi.length;
                options.body = multi.body;
                options.headers['content-type'] = multi.type;
                break;
            default : throw new Error('unsupported encoding:'+encoding);
        }
    }
  }
  //END FORM Hack

  // If onResponse is boolean true, call back immediately when the response is known,
  // not when the full request is complete.
  options.onResponse = options.onResponse || noop
  if(options.onResponse === true) {
    options.onResponse = callback
    options.callback = noop
  }

  // XXX Browsers do not like this.
  //if(options.body)
  //  options.headers['content-length'] = options.body.length;

  // HTTP basic authentication
  if(!options.headers.authorization && options.auth)
    options.headers.authorization = 'Basic ' + b64_enc(options.auth.username + ':' + options.auth.password);

  return run_xhr(options)
}

var req_seq = 0
function run_xhr(options) {
  var xhr = new XHR
    , timed_out = false
    , is_cors = is_crossDomain(options.uri)
    , supports_cors = ('withCredentials' in xhr)

  req_seq += 1
  xhr.seq_id = req_seq
  xhr.id = req_seq + ': ' + options.method + ' ' + options.uri
  xhr._id = xhr.id // I know I will type "_id" from habit all the time.

  if(is_cors && !supports_cors) {
    var cors_err = new Error('Browser does not support cross-origin request: ' + options.uri)
    cors_err.cors = 'unsupported'
    return options.callback(cors_err, xhr)
  }

  xhr.timeoutTimer = setTimeout(too_late, options.timeout)
  function too_late() {
    timed_out = true
    var er = new Error('ETIMEDOUT')
    er.code = 'ETIMEDOUT'
    er.duration = options.timeout

    request.log.error('Timeout', { 'id':xhr._id, 'milliseconds':options.timeout })
    return options.callback(er, xhr)
  }

  // Some states can be skipped over, so remember what is still incomplete.
  var did = {'response':false, 'loading':false, 'end':false}

  xhr.onreadystatechange = on_state_change
  xhr.open(options.method, options.uri, true) // asynchronous
  if(is_cors)
    xhr.withCredentials = !! options.withCredentials
  xhr.send(options.body)
  return xhr

  function on_state_change(event) {
    if(timed_out)
      return request.log.debug('Ignoring timed out state change', {'state':xhr.readyState, 'id':xhr.id})

    request.log.debug('State change', {'state':xhr.readyState, 'id':xhr.id, 'timed_out':timed_out})

    if(xhr.readyState === XHR.OPENED) {
      request.log.debug('Request started', {'id':xhr.id})
      for (var key in options.headers)
        xhr.setRequestHeader(key, options.headers[key])
    }

    else if(xhr.readyState === XHR.HEADERS_RECEIVED)
      on_response()

    else if(xhr.readyState === XHR.LOADING) {
      on_response()
      on_loading()
    }

    else if(xhr.readyState === XHR.DONE) {
      on_response()
      on_loading()
      on_end()
    }
  }

  function on_response() {
    if(did.response)
      return

    did.response = true
    request.log.debug('Got response', {'id':xhr.id, 'status':xhr.status})
    clearTimeout(xhr.timeoutTimer)
    xhr.statusCode = xhr.status // Node request compatibility

    // Detect failed CORS requests.
    if(is_cors && xhr.statusCode == 0) {
      var cors_err = new Error('CORS request rejected: ' + options.uri)
      cors_err.cors = 'rejected'

      // Do not process this request further.
      did.loading = true
      did.end = true

      return options.callback(cors_err, xhr)
    }

    options.onResponse(null, xhr)
  }

  function on_loading() {
    if(did.loading)
      return

    did.loading = true
    request.log.debug('Response body loading', {'id':xhr.id})
    // TODO: Maybe simulate "data" events by watching xhr.responseText
  }

  function on_end() {
    if(did.end)
      return

    did.end = true
    request.log.debug('Request done', {'id':xhr.id})

    xhr.body = xhr.responseText
    if(options.json) {
      try        { xhr.body = JSON.parse(xhr.responseText) }
      catch (er) { return options.callback(er, xhr)        }
    }

    options.callback(null, xhr, xhr.body)
  }

} // request

request.withCredentials = false;
request.DEFAULT_TIMEOUT = DEFAULT_TIMEOUT;

//
// defaults
//

request.defaults = function(options, requester) {
  var def = function (method) {
    var d = function (params, callback) {
      if(typeof params === 'string')
        params = {'uri': params};
      else {
        params = JSON.parse(JSON.stringify(params));
      }
      for (var i in options) {
        if (params[i] === undefined) params[i] = options[i]
      }
      return method(params, callback)
    }
    return d
  }
  var de = def(request)
  de.get = def(request.get)
  de.post = def(request.post)
  de.put = def(request.put)
  de.head = def(request.head)
  return de
}

//
// HTTP method shortcuts
//

var shortcuts = [ 'get', 'put', 'post', 'head' ];
shortcuts.forEach(function(shortcut) {
  var method = shortcut.toUpperCase();
  var func   = shortcut.toLowerCase();

  request[func] = function(opts) {
    if(typeof opts === 'string')
      opts = {'method':method, 'uri':opts};
    else {
      opts = JSON.parse(JSON.stringify(opts));
      opts.method = method;
    }

    var args = [opts].concat(Array.prototype.slice.apply(arguments, [1]));
    return request.apply(this, args);
  }
})

//
// CouchDB shortcut
//

request.couch = function(options, callback) {
  if(typeof options === 'string')
    options = {'uri':options}

  // Just use the request API to do JSON.
  options.json = true
  if(options.body)
    options.json = options.body
  delete options.body

  callback = callback || noop

  var xhr = request(options, couch_handler)
  return xhr

  function couch_handler(er, resp, body) {
    if(er)
      return callback(er, resp, body)

    if((resp.statusCode < 200 || resp.statusCode > 299) && body.error) {
      // The body is a Couch JSON object indicating the error.
      er = new Error('CouchDB error: ' + (body.error.reason || body.error.error))
      for (var key in body)
        er[key] = body[key]
      return callback(er, resp, body);
    }

    return callback(er, resp, body);
  }
}

//
// Utility
//

function noop() {}

function getLogger() {
  var logger = {}
    , levels = ['trace', 'debug', 'info', 'warn', 'error']
    , level, i

  for(i = 0; i < levels.length; i++) {
    level = levels[i]

    logger[level] = noop
    if(typeof console !== 'undefined' && console && console[level])
      logger[level] = formatted(console, level)
  }

  return logger
}

function formatted(obj, method) {
  return formatted_logger

  function formatted_logger(str, context) {
    if(typeof context === 'object')
      str += ' ' + JSON.stringify(context)

    return obj[method].call(obj, str)
  }
}

// Return whether a URL is a cross-domain request.
function is_crossDomain(url) {
  var rurl = /^([\w\+\.\-]+:)(?:\/\/([^\/?#:]*)(?::(\d+))?)?/

  // jQuery #8138, IE may throw an exception when accessing
  // a field from window.location if document.domain has been set
  var ajaxLocation
  try { ajaxLocation = location.href }
  catch (e) {
    // Use the href attribute of an A element since IE will modify it given document.location
    ajaxLocation = document.createElement( "a" );
    ajaxLocation.href = "";
    ajaxLocation = ajaxLocation.href;
  }

  var ajaxLocParts = rurl.exec(ajaxLocation.toLowerCase()) || []
    , parts = rurl.exec(url.toLowerCase() )

  var result = !!(
    parts &&
    (  parts[1] != ajaxLocParts[1]
    || parts[2] != ajaxLocParts[2]
    || (parts[3] || (parts[1] === "http:" ? 80 : 443)) != (ajaxLocParts[3] || (ajaxLocParts[1] === "http:" ? 80 : 443))
    )
  )

  //console.debug('is_crossDomain('+url+') -> ' + result)
  return result
}

// MIT License from http://phpjs.org/functions/base64_encode:358
function b64_enc (data) {
    // Encodes string using MIME base64 algorithm
    var b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
    var o1, o2, o3, h1, h2, h3, h4, bits, i = 0, ac = 0, enc="", tmp_arr = [];

    if (!data) {
        return data;
    }

    // assume utf8 data
    // data = this.utf8_encode(data+'');

    do { // pack three octets into four hexets
        o1 = data.charCodeAt(i++);
        o2 = data.charCodeAt(i++);
        o3 = data.charCodeAt(i++);

        bits = o1<<16 | o2<<8 | o3;

        h1 = bits>>18 & 0x3f;
        h2 = bits>>12 & 0x3f;
        h3 = bits>>6 & 0x3f;
        h4 = bits & 0x3f;

        // use hexets to index into b64, and append result to encoded string
        tmp_arr[ac++] = b64.charAt(h1) + b64.charAt(h2) + b64.charAt(h3) + b64.charAt(h4);
    } while (i < data.length);

    enc = tmp_arr.join('');

    switch (data.length % 3) {
        case 1:
            enc = enc.slice(0, -2) + '==';
        break;
        case 2:
            enc = enc.slice(0, -1) + '=';
        break;
    }

    return enc;
}
    return request;
//UMD FOOTER START
}));
//UMD FOOTER END

},{}],3:[function(require,module,exports){
(function (global){
var matrixcs = require("./lib/matrix");
matrixcs.request(require("browser-request"));
module.exports = matrixcs; // keep export for browserify package deps
global.matrixcs = matrixcs;

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./lib/matrix":1,"browser-request":2}]},{},[3]);
