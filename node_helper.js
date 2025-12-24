const NodeHelper = require('node_helper');
const Log = require('logger');
const { AsyncDeviceDiscovery, Listener: listener } = require('sonos');

// Utility function to wrap promises with timeout
function withTimeout(promise, ms, errorMessage = 'Operation timed out') {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(errorMessage));
        }, ms);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
        clearTimeout(timeoutId);
    });
}

// Default timeout values (can be overridden via config)
const DEFAULT_TIMEOUTS = {
    discovery: 10000,      // 10 seconds for discovery
    subscribe: 5000,       // 5 seconds for subscription
    apiCall: 5000,         // 5 seconds for regular API calls
    getAllGroups: 10000    // 10 seconds for getting all groups
};

module.exports = NodeHelper.create({

    discovery: null,
    asyncDevice: null,
    config: null,
    debug: false,
    subscribedDevices: [],
    pollingIntervals: [],
    groupsById: {},

    // Groups reference for health checking
    groups: [],

    // Per-group health state for adaptive polling and failure detection
    groupHealth: {},

    // Subscription health check timer (runs every 5 min when playing)
    subscriptionCheckTimer: null,

    // Adaptive polling timeout (setTimeout-based for dynamic intervals)
    pollTimeout: null,

    // Polling failure tracking (for polling-only mode)
    pollingFailureCounts: {},

    // Prevent re-entrant rediscovery calls
    isRediscovering: false,

    init: function () {
        this.discovery = new AsyncDeviceDiscovery();

        // Add global error handler for the listener (remove first to prevent accumulation)
        listener.removeAllListeners('error');
        listener.on('error', (error) => {
            Log.error(`[MMM-Sonos] Listener error: ${error.message}`);
            this.handleListenerError(error);
        });
    },

    debugLog: function (message) {
        if (this.debug) {
            Log.log(`[MMM-Sonos] [DEBUG] ${message}`);
        }
    },

    handleListenerError: function(error) {
        Log.error('[MMM-Sonos] Handling listener error, will rediscover...');
        this.triggerRediscovery();
    },

    stop: function () {
        // Reset rediscovery flag to ensure clean shutdown
        this.isRediscovering = false;

        // Clear subscription health check timer
        if (this.subscriptionCheckTimer) {
            clearInterval(this.subscriptionCheckTimer);
            this.subscriptionCheckTimer = null;
        }

        // Clear adaptive polling timeout
        if (this.pollTimeout) {
            clearTimeout(this.pollTimeout);
            this.pollTimeout = null;
        }

        // Clear polling intervals (for polling-only mode)
        this.pollingIntervals.forEach(id => clearInterval(id));
        this.pollingIntervals = [];
        this.pollingFailureCounts = {};

        // Clear group health state
        this.groupHealth = {};
        this.groups = [];

        // Remove event listeners from subscribed devices
        this.subscribedDevices.forEach(device => {
            device.removeAllListeners('CurrentTrack');
            device.removeAllListeners('Volume');
            device.removeAllListeners('Muted');
            device.removeAllListeners('PlayState');
            device.removeAllListeners('error');
        });
        this.subscribedDevices = [];

        // Stop global listener
        if (listener.isListening()) {
            listener.stopListener().then(() => {
                this.debugLog('Stopped all listeners to Sonos devices');
            }).catch(error => {
                Log.error(`[MMM-Sonos] Failed to stop listeners to Sonos devices, connections might be dangling: ${error.message}`);
            });
        }
    },

    socketNotificationReceived: function (id, payload) {
        switch (id) {
            case 'SONOS_START':
                this.config = payload;
                this.debug = payload.debug || false;
                this.discoverGroups();
                break;
            case 'SONOS_TOGGLE_PLAY_PAUSE':
                this.handleTogglePlayPause(payload.groupId);
                break;
            case 'SONOS_NEXT':
                this.handleNext(payload.groupId);
                break;
            case 'SONOS_SET_VOLUME':
                this.handleSetVolume(payload.groupId, payload.volume);
                break;
            default:
                Log.log(`Notification with ID "${id}" unsupported. Ignoring...`);
                break;
        }
    },

    discoverGroups: function (attempts = 0) {
        const timeouts = this.config?.timeouts || DEFAULT_TIMEOUTS;

        if (!this.asyncDevice) {
            this.asyncDevice = withTimeout(
                this.discovery.discover(),
                timeouts.discovery,
                'Sonos device discovery timed out'
            ).then(device => {
                // Remove existing ZonesChanged listener to prevent accumulation on rediscovery
                listener.removeAllListeners('ZonesChanged');
                listener.on('ZonesChanged', () => {
                    Log.log(`[MMM-Sonos] Zones have changed. Rediscovering all groups ...`);
                    this.discoverGroups();
                });
                return withTimeout(
                    listener.subscribeTo(device),
                    timeouts.subscribe,
                    'Subscription to Sonos listener timed out'
                ).then(() => device);
            });
        }

        this.asyncDevice.then(device => {
            return withTimeout(
                device.getAllGroups(),
                timeouts.getAllGroups,
                'getAllGroups timed out'
            );
        }).then(groups => {
            this.setGroups(groups);
        }).catch(error => {
            attempts++;
            const timeout = Math.min(Math.pow(attempts, 2), 30);
            Log.error(`[MMM-Sonos] Failed to get groups: ${error.message}. Retrying in ${timeout} seconds ...`);
            if (listener.isListening()) {
                listener.stopListener().then(() => {
                    this.debugLog('Stopped all listeners to Sonos devices');
                }).catch(error => {
                    Log.error(`[MMM-Sonos] Failed to stop listeners to Sonos devices, connections might be dangling: ${error.message}`);
                });
            }
            this.asyncDevice = null;
            setTimeout(() => {
                this.discoverGroups(attempts);
            }, timeout * 1000);
        });
    },

    shouldIncludeGroup: function(group, rooms) {
        if (!rooms || rooms.length === 0) return true;

        const zoneNames = group.ZoneGroupMember
            .filter(m => m.ZoneName)
            .map(m => m.ZoneName.toLowerCase());
        const normalizedRooms = rooms
            .filter(r => typeof r === 'string')
            .map(r => r.toLowerCase());

        return zoneNames.some(zone => normalizedRooms.includes(zone));
    },

    setGroups(groups) {
        const filteredGroups = groups.filter(group =>
            this.shouldIncludeGroup(group, this.config.rooms)
        );

        const timeouts = this.config?.timeouts || DEFAULT_TIMEOUTS;
        const apiTimeout = timeouts.apiCall;

        // Use Promise.allSettled for resilience - individual device failures won't break everything
        Promise.all(filteredGroups.map(group => {
            const sonos = group.CoordinatorDevice();
            return Promise.allSettled([
                withTimeout(sonos.currentTrack(), apiTimeout, `currentTrack timed out for ${group.Name}`),
                withTimeout(sonos.getCurrentState(), apiTimeout, `getCurrentState timed out for ${group.Name}`),
                withTimeout(sonos.getVolume(), apiTimeout, `getVolume timed out for ${group.Name}`),
                withTimeout(sonos.getMuted(), apiTimeout, `getMuted timed out for ${group.Name}`)
            ]).then(results => {
                // Extract values, using defaults for failed promises
                const track = results[0].status === 'fulfilled' ? results[0].value : null;
                const state = results[1].status === 'fulfilled' ? results[1].value : 'unknown';
                const volume = results[2].status === 'fulfilled' ? results[2].value : 0;
                const isMuted = results[3].status === 'fulfilled' ? results[3].value : false;

                // Log any failures
                results.forEach((result, index) => {
                    if (result.status === 'rejected') {
                        const methods = ['currentTrack', 'getCurrentState', 'getVolume', 'getMuted'];
                        Log.error(`[MMM-Sonos] ${methods[index]} failed for "${group.Name}": ${result.reason?.message || result.reason}`);
                    }
                });

                return {
                    group,
                    track,
                    state,
                    volume,
                    isMuted,
                };
            });
        })).then(items => {
            // Filter out items with no track data (completely failed groups)
            const validItems = items.filter(item => item.track !== null);

            if (validItems.length === 0 && items.length > 0) {
                Log.warn('[MMM-Sonos] All groups failed to return data, will retry...');
                throw new Error('All groups failed to return data');
            }

            // Store groups by ID for control commands
            this.groupsById = validItems.reduce((map, item) => {
                map[item.group.ID] = item.group;
                return map;
            }, {});

            this.sendSocketNotification('SET_SONOS_GROUPS', validItems.reduce((map, item) => {
                map[item.group.ID] = item;
                return map;
            }, {}));
            return validItems;
        }).then(validGroups => {
            if (validGroups.length === 0) {
                Log.warn('[MMM-Sonos] No valid groups found after filtering');
                return;
            }

            if (this.config && this.config.listenWithPolling) {
                Log.log("[MMM-Sonos] Listening with polling mode");
                this.setListenersPolling(validGroups.map(item => item.group), this.config.pollingTime);
            } else if (this.config && this.config.hybridMode) {
                Log.log("[MMM-Sonos] Listening with hybrid mode (events + backup polling)");
                this.setListenersHybrid(validGroups.map(item => item.group));
            } else {
                Log.log("[MMM-Sonos] Listening with events mode");
                this.setListeners(validGroups.map(item => item.group));
            }
        }).catch(error => {
            Log.error(`[MMM-Sonos] Error in setGroups: ${error.message}`);
            // Schedule a retry after 10 seconds
            setTimeout(() => {
                this.discoverGroups();
            }, 10000);
        });
    },

    setListenersPolling: function (groups, pollingTimeout) {
        // Clear existing polling intervals before adding new ones
        this.pollingIntervals.forEach(id => clearInterval(id));
        this.pollingIntervals = [];
        this.pollingFailureCounts = {};

        const maxFailures = this.config?.maxConsecutiveFailures || 3;
        const timeouts = this.config?.timeouts || DEFAULT_TIMEOUTS;
        const apiTimeout = timeouts.apiCall;

        groups.forEach(group => {
            Log.log(`[MMM-Sonos] Registering polling for group "${group.Name}" (host "${group.host}")`);

            const sonos = group.CoordinatorDevice();
            let lastTrack = null;
            let lastVolume = null;
            let lastMute = null;
            let lastState = null;

            // Initialize failure counter for this group
            this.pollingFailureCounts[group.ID] = 0;

            const intervalId = setInterval(() => {
                // Poll all values in parallel with timeouts, handling each independently
                Promise.allSettled([
                    withTimeout(sonos.currentTrack(), apiTimeout, 'currentTrack polling timed out'),
                    withTimeout(sonos.getVolume(), apiTimeout, 'getVolume polling timed out'),
                    withTimeout(sonos.getMuted(), apiTimeout, 'getMuted polling timed out'),
                    withTimeout(sonos.getCurrentState(), apiTimeout, 'getCurrentState polling timed out')
                ]).then(results => {
                    // Count how many failed
                    const failedCount = results.filter(r => r.status === 'rejected').length;

                    if (failedCount === results.length) {
                        // All calls failed - increment failure counter
                        this.pollingFailureCounts[group.ID]++;
                        Log.error(`[MMM-Sonos] All polling calls failed for "${group.Name}" (${this.pollingFailureCounts[group.ID]}/${maxFailures})`);

                        if (this.pollingFailureCounts[group.ID] >= maxFailures) {
                            Log.error(`[MMM-Sonos] Max consecutive failures reached for "${group.Name}". Triggering rediscovery...`);
                            this.triggerPollingRediscovery();
                            return;
                        }
                    } else {
                        // At least one call succeeded - reset failure counter
                        this.pollingFailureCounts[group.ID] = 0;
                    }

                    // Handle track changes
                    if (results[0].status === 'fulfilled') {
                        const track = results[0].value;
                        if (
                            !lastTrack ||
                            lastTrack.title !== track.title ||
                            lastTrack.artist !== track.artist ||
                            lastTrack.album !== track.album ||
                            lastTrack.duration !== track.duration
                        ) {
                            Log.log(`[MMM-Sonos] [Group ${group.Name} - ${group.host}] Track changed to "${track.title}" by "${track.artist}"`);
                            lastTrack = track;
                            this.sendSocketNotification('SET_SONOS_CURRENT_TRACK', {
                                group,
                                track
                            });
                        }
                    } else {
                        Log.error(`[MMM-Sonos] Failed to get current track for "${group.Name}": ${results[0].reason?.message || results[0].reason}`);
                    }

                    // Handle volume changes
                    if (results[1].status === 'fulfilled') {
                        const volume = results[1].value;
                        if (lastVolume !== volume) {
                            this.debugLog(`[Group ${group.Name} - ${group.host}] Volume changed to "${volume}"`);
                            lastVolume = volume;
                            this.sendSocketNotification('SET_SONOS_VOLUME', {
                                group,
                                volume
                            });
                        }
                    } else {
                        Log.error(`[MMM-Sonos] Failed to get volume for "${group.Name}": ${results[1].reason?.message || results[1].reason}`);
                    }

                    // Handle mute changes
                    if (results[2].status === 'fulfilled') {
                        const isMuted = results[2].value;
                        const currentIsMuted = isMuted ? 'muted' : 'unmuted';
                        if (lastMute !== currentIsMuted) {
                            this.debugLog(`[Group ${group.Name} - ${group.host}] Group is ${currentIsMuted}`);
                            lastMute = currentIsMuted;
                            this.sendSocketNotification('SET_SONOS_MUTE', {
                                group,
                                isMuted
                            });
                        }
                    } else {
                        Log.error(`[MMM-Sonos] Failed to get mute state for "${group.Name}": ${results[2].reason?.message || results[2].reason}`);
                    }

                    // Handle play state changes
                    if (results[3].status === 'fulfilled') {
                        const state = results[3].value;
                        if (lastState !== state) {
                            Log.log(`[MMM-Sonos] [Group ${group.Name} - ${group.host}] Play state change to "${state}"`);
                            lastState = state;
                            this.sendSocketNotification('SET_SONOS_PLAY_STATE', {
                                group,
                                state
                            });
                        }
                    } else {
                        Log.error(`[MMM-Sonos] Failed to get play state for "${group.Name}": ${results[3].reason?.message || results[3].reason}`);
                    }
                });
            }, pollingTimeout);

            this.pollingIntervals.push(intervalId);
        });
    },

    triggerPollingRediscovery: function() {
        // Prevent re-entrant calls
        if (this.isRediscovering) {
            this.debugLog('Rediscovery already in progress, skipping');
            return;
        }
        this.isRediscovering = true;

        Log.warn('[MMM-Sonos] Triggering rediscovery due to polling failures');

        // Clear all polling intervals
        this.pollingIntervals.forEach(id => clearInterval(id));
        this.pollingIntervals = [];
        this.pollingFailureCounts = {};

        // Clean up and rediscover
        this.asyncDevice = null;
        if (listener.isListening()) {
            listener.stopListener().catch(e => {
                Log.error(`[MMM-Sonos] Failed to stop listener: ${e.message}`);
            });
        }

        // Delay rediscovery to avoid rapid retries
        setTimeout(() => {
            this.isRediscovering = false;
            this.discoverGroups();
        }, 5000);
    },

    setListeners: function (groups) {
        // Clean up existing listeners before adding new ones
        this.subscribedDevices.forEach(device => {
            device.removeAllListeners('CurrentTrack');
            device.removeAllListeners('Volume');
            device.removeAllListeners('Muted');
            device.removeAllListeners('PlayState');
            device.removeAllListeners('error');
        });
        this.subscribedDevices = [];

        // Subscribe to each group and set up event listeners
        const subscribePromises = groups.map(group => {
            Log.log(`[MMM-Sonos] Registering listeners for group "${group.Name}" (host "${group.host}")`);
            const sonos = group.CoordinatorDevice();

            // Subscribe first, then attach handlers
            return listener.subscribeTo(sonos)
                .then(() => {
                    this.subscribedDevices.push(sonos);
                    this.debugLog(`[${group.Name}] Subscription created`);

                    // Add error handler for this device
                    sonos.on('error', error => {
                        Log.error(`[MMM-Sonos] [Group ${group.Name} - ${group.host}] Device error: ${error.message}`);
                    });

                    sonos.on('CurrentTrack', track => {
                        Log.log(`[MMM-Sonos] [Group ${group.Name} - ${group.host}] Track changed to "${track.title}" by "${track.artist}"`);
                        this.sendSocketNotification('SET_SONOS_CURRENT_TRACK', {
                            group,
                            track
                        });
                    });

                    sonos.on('Volume', volume => {
                        this.debugLog(`[Group ${group.Name} - ${group.host}] Volume changed to "${volume}"`);
                        this.sendSocketNotification('SET_SONOS_VOLUME', {
                            group,
                            volume
                        });
                    });

                    sonos.on('Muted', isMuted => {
                        this.debugLog(`[Group ${group.Name} - ${group.host}] Group is ${isMuted ? 'muted' : 'unmuted'}`);
                        this.sendSocketNotification('SET_SONOS_MUTE', {
                            group,
                            isMuted
                        });
                    });

                    sonos.on('PlayState', state => {
                        Log.log(`[MMM-Sonos] [Group ${group.Name} - ${group.host}] Play state change to "${state}"`);
                        this.sendSocketNotification('SET_SONOS_PLAY_STATE', {
                            group,
                            state
                        });
                    });
                })
                .catch(err => {
                    Log.error(`[MMM-Sonos] Failed to subscribe to "${group.Name}": ${err.message}`);
                });
        });

        // Track subscription completion (no action needed, just for consistency with hybrid mode)
        Promise.allSettled(subscribePromises);

        // Note: No watchdog in events-only mode - it can't distinguish between
        // "events are broken" and "nothing is playing". Use hybrid mode for self-healing.
    },

    // Subscription health check - verifies UPnP subscriptions are alive
    startSubscriptionHealthCheck: function() {
        if (!this.config?.autoResubscribe) {
            this.debugLog('Auto-resubscribe disabled, skipping subscription health check');
            return;
        }

        // Clear any existing timer
        if (this.subscriptionCheckTimer) {
            clearInterval(this.subscriptionCheckTimer);
        }

        const checkInterval = this.config?.subscriptionCheckInterval || 300000; // 5 min default

        this.subscriptionCheckTimer = setInterval(() => {
            this.debugLog('Subscription health check triggered');

            // Intentional: Only check subscriptions when music is playing.
            // When idle, the library's built-in renewal (every 25 min) handles subscriptions.
            // If a subscription dies while idle, the first poll after playback starts catches it.
            // This tradeoff reduces network traffic during idle periods.
            if (!this.isAnyGroupPlaying()) {
                this.debugLog('Skipping subscription check - no music playing');
                return;
            }

            // Guard: skip if no groups to check
            if (!this.groups || this.groups.length === 0) {
                this.debugLog('No groups to check');
                return;
            }

            this.debugLog(`Running subscription health check for ${this.groups.length} groups`);
            this.debugLog(`Listener has ${listener._deviceSubscriptions?.length || 0} total subscriptions`);

            this.groups.forEach(group => {
                // Use stored device reference (not CoordinatorDevice() which returns new object each time)
                const health = this.groupHealth[group.ID];
                if (!health || !health.device) {
                    this.debugLog(`[${group.Name}] No device reference stored, triggering rediscovery`);
                    this.triggerRediscovery();
                    return;
                }
                this.renewDeviceSubscriptions(health.device, group);
            });
        }, checkInterval);

        Log.log(`[MMM-Sonos] Subscription health check started (interval: ${checkInterval}ms)`);
    },

    renewDeviceSubscriptions: function(device, group) {
        // Log device info for debugging (no branching on _isSubscribed)
        this.debugLog(`[${group.Name}] Device ${device.host}, _isSubscribed: ${device._isSubscribed}`);

        // Find the DeviceSubscription object from the listener
        const deviceSubscription = listener._deviceSubscriptions?.find(
            sub => sub.device === device
        );

        if (!deviceSubscription) {
            this.debugLog(`[${group.Name}] No DeviceSubscription found, triggering rediscovery`);
            this.triggerRediscovery();
            return;
        }

        this.debugLog(`[${group.Name}] Attempting subscription renewal...`);

        const timeouts = this.config?.timeouts || DEFAULT_TIMEOUTS;
        const renewTimeout = timeouts.apiCall || 5000;

        withTimeout(
            deviceSubscription.renewAllSubscriptions(),
            renewTimeout,
            `Subscription renewal timed out for "${group.Name}"`
        )
            .then(() => {
                this.debugLog(`[${group.Name}] Subscription renewal succeeded`);
            })
            .catch(err => {
                Log.warn(`[MMM-Sonos] Renewal failed for "${group.Name}": ${err.message}, triggering rediscovery`);
                this.triggerRediscovery();
            });
    },

    attachEventHandlers: function(group, device) {
        const groupId = group.ID;

        // Remove any existing listeners to prevent duplicates when re-attaching
        device.removeAllListeners('CurrentTrack');
        device.removeAllListeners('Volume');
        device.removeAllListeners('Muted');
        device.removeAllListeners('PlayState');
        device.removeAllListeners('error');

        // Ensure device is in subscribedDevices list
        if (!this.subscribedDevices.includes(device)) {
            this.subscribedDevices.push(device);
        }

        device.on('error', error => {
            Log.error(`[MMM-Sonos] [${group.Name}] Device error: ${error.message}`);
        });

        device.on('CurrentTrack', track => {
            Log.log(`[MMM-Sonos] [${group.Name}] Track: "${track.title}"`);
            // Sync with groupHealth to prevent duplicate notifications from polling
            const health = this.groupHealth[groupId];
            if (health) health.lastTrack = track;
            this.sendSocketNotification('SET_SONOS_CURRENT_TRACK', { group, track });
        });

        device.on('Volume', volume => {
            this.debugLog(`[${group.Name}] Volume: ${volume}`);
            // Sync with groupHealth to prevent duplicate notifications from polling
            const health = this.groupHealth[groupId];
            if (health) health.lastVolume = volume;
            this.sendSocketNotification('SET_SONOS_VOLUME', { group, volume });
        });

        device.on('Muted', isMuted => {
            this.debugLog(`[${group.Name}] Muted: ${isMuted}`);
            // Sync with groupHealth to prevent duplicate notifications from polling
            const health = this.groupHealth[groupId];
            if (health) health.lastMuted = isMuted;
            this.sendSocketNotification('SET_SONOS_MUTE', { group, isMuted });
        });

        device.on('PlayState', state => {
            Log.log(`[MMM-Sonos] [${group.Name}] State: ${state}`);
            const health = this.groupHealth[groupId];
            if (health) health.playState = state;
            this.sendSocketNotification('SET_SONOS_PLAY_STATE', { group, state });
        });
    },

    // Adaptive polling methods
    isAnyGroupPlaying: function() {
        return Object.values(this.groupHealth).some(
            h => h.playState === 'playing'
        );
    },

    getPollingInterval: function() {
        const playingInterval = this.config?.pollingIntervalPlaying || 15000;
        const idleInterval = this.config?.pollingIntervalIdle || 60000;
        return this.isAnyGroupPlaying() ? playingInterval : idleInterval;
    },

    schedulePoll: function() {
        // Clear any existing timeout
        if (this.pollTimeout) {
            clearTimeout(this.pollTimeout);
        }

        const interval = this.getPollingInterval();
        this.debugLog(`Scheduling poll in ${interval}ms`);

        this.pollTimeout = setTimeout(() => {
            this.debugLog('Poll timer fired, starting poll cycle');
            this.pollAllGroups().finally(() => {
                // Only reschedule if polling hasn't been stopped (e.g., by rediscovery)
                if (this.pollTimeout !== null) {
                    this.schedulePoll();
                } else {
                    this.debugLog('Poll chain stopped (pollTimeout is null)');
                }
            });
        }, interval);
    },

    pollAllGroups: function() {
        this.debugLog(`Polling ${this.groups.length} groups`);
        const promises = this.groups.map(group => this.pollGroup(group));
        return Promise.allSettled(promises);
    },

    pollGroup: function(group) {
        const device = group.CoordinatorDevice();
        const health = this.groupHealth[group.ID];

        // Guard: skip if group health not initialized (shouldn't happen, but defensive)
        if (!health) {
            this.debugLog(`No health state for group "${group.Name}", skipping poll`);
            return Promise.resolve();
        }

        const timeouts = this.config?.timeouts || DEFAULT_TIMEOUTS;
        const apiTimeout = timeouts.apiCall;
        const maxFailures = this.config?.maxConsecutiveFailures || 3;

        return Promise.allSettled([
            withTimeout(device.currentTrack(), apiTimeout),
            withTimeout(device.getVolume(), apiTimeout),
            withTimeout(device.getMuted(), apiTimeout),
            withTimeout(device.getCurrentState(), apiTimeout)
        ]).then(results => {
            const anySucceeded = results.some(r => r.status === 'fulfilled');

            if (!anySucceeded) {
                // All polls failed
                health.consecutiveFailures++;
                Log.error(`[MMM-Sonos] Poll failed for "${group.Name}" (${health.consecutiveFailures}/${maxFailures})`);

                if (health.consecutiveFailures >= maxFailures) {
                    this.triggerRediscovery();
                }
                return;
            }

            // Reset failure count on success
            health.consecutiveFailures = 0;

            this.debugLog(`[${group.Name}] Poll API results: track=${results[0].status}, vol=${results[1].status}, mute=${results[2].status}, state=${results[3].status}`);

            // Track last known values to avoid sending duplicate updates
            if (results[0].status === 'fulfilled' && results[0].value) {
                const track = results[0].value;
                // Compare by metadata (title, artist, album, duration) rather than URI
                // URI is unreliable for streaming sources (AirPlay, Google Home, Alexa)
                // where all tracks share the same stream URI
                const trackChanged = !health.lastTrack ||
                    health.lastTrack.title !== track.title ||
                    health.lastTrack.artist !== track.artist ||
                    health.lastTrack.album !== track.album ||
                    health.lastTrack.duration !== track.duration;

                this.debugLog(`[${group.Name}] Poll track: "${track.title}" by "${track.artist}", last: "${health.lastTrack?.title || 'none'}", changed: ${trackChanged}`);

                if (trackChanged) {
                    health.lastTrack = track;
                    this.sendSocketNotification('SET_SONOS_CURRENT_TRACK', { group, track });
                }
            }

            if (results[1].status === 'fulfilled') {
                const volume = results[1].value;
                if (health.lastVolume !== volume) {
                    health.lastVolume = volume;
                    this.sendSocketNotification('SET_SONOS_VOLUME', { group, volume });
                }
            }

            if (results[2].status === 'fulfilled') {
                const isMuted = results[2].value;
                if (health.lastMuted !== isMuted) {
                    health.lastMuted = isMuted;
                    this.sendSocketNotification('SET_SONOS_MUTE', { group, isMuted });
                }
            }

            if (results[3].status === 'fulfilled') {
                const state = results[3].value;
                if (health.playState !== state) {
                    health.playState = state;
                    this.sendSocketNotification('SET_SONOS_PLAY_STATE', { group, state });
                }
            }
        });
    },

    triggerRediscovery: function() {
        // Prevent re-entrant calls
        if (this.isRediscovering) {
            this.debugLog('Rediscovery already in progress, skipping');
            return;
        }
        this.isRediscovering = true;

        Log.warn('[MMM-Sonos] Triggering full rediscovery...');

        // Clear subscription health check timer
        this.debugLog('Clearing subscription health check timer');
        if (this.subscriptionCheckTimer) {
            clearInterval(this.subscriptionCheckTimer);
            this.subscriptionCheckTimer = null;
        }

        // Clear adaptive polling timeout
        this.debugLog(`Clearing poll timeout (was: ${this.pollTimeout})`);
        if (this.pollTimeout) {
            clearTimeout(this.pollTimeout);
            this.pollTimeout = null;
        }

        this.debugLog('Cleaning up existing state...');

        // Clean up existing state
        this.subscribedDevices.forEach(device => {
            device.removeAllListeners('CurrentTrack');
            device.removeAllListeners('Volume');
            device.removeAllListeners('Muted');
            device.removeAllListeners('PlayState');
            device.removeAllListeners('error');
        });
        this.subscribedDevices = [];
        this.groupHealth = {};
        this.groups = [];

        if (listener.isListening()) {
            listener.stopListener().catch(e => {
                Log.error(`[MMM-Sonos] Failed to stop listener during rediscovery: ${e.message}`);
            });
        }

        // Clear stale DeviceSubscription entries (library bug - doesn't do this itself)
        if (listener._deviceSubscriptions) {
            listener._deviceSubscriptions.length = 0;
        }

        this.asyncDevice = null;

        // Start fresh discovery after a short delay
        setTimeout(() => {
            this.isRediscovering = false;
            this.discoverGroups();
        }, 2000);
    },

    // Hybrid mode: events + adaptive polling for maximum reliability
    setListenersHybrid: function(groups) {
        // Store groups reference for health checking
        this.groups = groups;

        // Clean up existing listeners
        this.subscribedDevices.forEach(device => {
            device.removeAllListeners('CurrentTrack');
            device.removeAllListeners('Volume');
            device.removeAllListeners('Muted');
            device.removeAllListeners('PlayState');
            device.removeAllListeners('error');
        });
        this.subscribedDevices = [];

        // Clear any existing polling
        if (this.pollTimeout) {
            clearTimeout(this.pollTimeout);
            this.pollTimeout = null;
        }

        // Initialize health state for each group
        this.groupHealth = {};
        groups.forEach(group => {
            this.groupHealth[group.ID] = {
                device: null,  // Will be set after subscription succeeds
                playState: 'unknown',
                consecutiveFailures: 0,
                lastTrack: null,
                lastVolume: null,
                lastMuted: null
            };
        });

        // Subscribe to each group and set up event listeners
        const subscribePromises = groups.map(group => {
            Log.log(`[MMM-Sonos] Registering hybrid listeners for group "${group.Name}" (host "${group.host}")`);
            const device = group.CoordinatorDevice();
            // Note: attachEventHandlers() adds device to subscribedDevices

            return listener.subscribeTo(device)
                .then(() => {
                    this.debugLog(`[${group.Name}] Subscription created`);
                    // Store device reference for health check to use
                    this.groupHealth[group.ID].device = device;
                    this.attachEventHandlers(group, device);
                })
                .catch(err => {
                    Log.error(`[MMM-Sonos] Failed to subscribe to "${group.Name}": ${err.message}`);
                });
        });

        // Start polling and health check after subscriptions are set up
        Promise.allSettled(subscribePromises).then(() => {
            const playingInterval = this.config?.pollingIntervalPlaying ?? 15000;
            const idleInterval = this.config?.pollingIntervalIdle ?? 60000;

            if (playingInterval === 0) {
                Log.log(`[MMM-Sonos] Hybrid mode: Events + health checks (polling disabled)`);
            } else {
                Log.log(`[MMM-Sonos] Hybrid mode: Adaptive polling (${playingInterval}ms playing / ${idleInterval}ms idle)`);
                this.schedulePoll();
            }

            // Start subscription health check
            this.startSubscriptionHealthCheck();
        });
    },

    handleTogglePlayPause: function(groupId) {
        const group = this.groupsById[groupId];
        if (!group) {
            Log.error(`[MMM-Sonos] Group not found for ID: ${groupId}`);
            return;
        }

        const sonos = group.CoordinatorDevice();
        sonos.togglePlayback()
            .then(() => {
                this.debugLog(`Toggle play/pause for group: ${group.Name}`);
            })
            .catch(error => {
                Log.error(`[MMM-Sonos] Failed to toggle playback: ${error.message}`);
            });
    },

    handleNext: function(groupId) {
        const group = this.groupsById[groupId];
        if (!group) {
            Log.error(`[MMM-Sonos] Group not found for ID: ${groupId}`);
            return;
        }

        const sonos = group.CoordinatorDevice();
        sonos.next()
            .then(() => {
                this.debugLog(`Skip to next for group: ${group.Name}`);
            })
            .catch(error => {
                Log.error(`[MMM-Sonos] Failed to skip track: ${error.message}`);
            });
    },

    handleSetVolume: function(groupId, volume) {
        const group = this.groupsById[groupId];
        if (!group) {
            Log.error(`[MMM-Sonos] Group not found for ID: ${groupId}`);
            return;
        }

        // Validate volume range
        volume = Math.max(0, Math.min(100, parseInt(volume, 10)));
        if (isNaN(volume)) {
            Log.error(`[MMM-Sonos] Invalid volume value`);
            return;
        }

        const sonos = group.CoordinatorDevice();
        sonos.setVolume(volume)
            .then(() => {
                this.debugLog(`Set volume to ${volume} for group: ${group.Name}`);
            })
            .catch(error => {
                Log.error(`[MMM-Sonos] Failed to set volume: ${error.message}`);
            });
    }
});