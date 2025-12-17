const NodeHelper = require('node_helper');
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
    subscribedDevices: [],
    pollingIntervals: [],
    groupsById: {},

    // Watchdog properties for detecting silent failures in events mode
    lastUpdateTimestamp: null,
    watchdogTimer: null,

    // Polling failure tracking
    pollingFailureCounts: {},

    // Prevent re-entrant rediscovery calls
    isRediscovering: false,

    init: function () {
        this.discovery = new AsyncDeviceDiscovery();

        // Add global error handler for the listener (remove first to prevent accumulation)
        listener.removeAllListeners('error');
        listener.on('error', (error) => {
            console.error(`[MMM-Sonos] Listener error: ${error.message}`);
            this.handleListenerError(error);
        });
    },

    handleListenerError: function(error) {
        console.error('[MMM-Sonos] Handling listener error, will rediscover...');
        this.triggerRediscovery();
    },

    stop: function () {
        // Stop watchdog timer
        this.stopWatchdog();

        // Clear polling intervals
        this.pollingIntervals.forEach(id => clearInterval(id));
        this.pollingIntervals = [];
        this.pollingFailureCounts = {};

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
                console.debug('[MMM-Sonos] Stopped all listeners to Sonos devices');
            }).catch(error => {
                console.error(`[MMM-Sonos] Failed to stop listeners to Sonos devices, connections might be dangling: ${error.message}`);
            });
        }
    },

    socketNotificationReceived: function (id, payload) {
        switch (id) {
            case 'SONOS_START':
                this.config = payload
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
                console.log(`Notification with ID "${id}" unsupported. Ignoring...`);
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
                    console.log(`[MMM-Sonos] Zones have changed. Rediscovering all groups ...`);
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
            console.error(`[MMM-Sonos] Failed to get groups: ${error.message}. Retrying in ${timeout} seconds ...`);
            if (listener.isListening()) {
                listener.stopListener().then(() => {
                    console.debug('[MMM-Sonos] Stopped all listeners to Sonos devices');
                }).catch(error => {
                    console.error(`[MMM-Sonos] Failed to stop listeners to Sonos devices, connections might be dangling: ${error.message}`);
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
                        console.error(`[MMM-Sonos] ${methods[index]} failed for "${group.Name}": ${result.reason?.message || result.reason}`);
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
                console.warn('[MMM-Sonos] All groups failed to return data, will retry...');
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
                console.warn('[MMM-Sonos] No valid groups found after filtering');
                return;
            }

            if (this.config && this.config.listenWithPolling) {
                console.log("[MMM-Sonos] Listening with polling mode");
                this.setListenersPolling(validGroups.map(item => item.group), this.config.pollingTime);
            } else if (this.config && this.config.hybridMode) {
                console.log("[MMM-Sonos] Listening with hybrid mode (events + backup polling)");
                this.setListenersHybrid(validGroups.map(item => item.group));
            } else {
                console.log("[MMM-Sonos] Listening with events mode");
                this.setListeners(validGroups.map(item => item.group));
            }
        }).catch(error => {
            console.error(`[MMM-Sonos] Error in setGroups: ${error.message}`);
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

        const maxFailures = this.config?.maxConsecutiveFailures || 5;
        const timeouts = this.config?.timeouts || DEFAULT_TIMEOUTS;
        const apiTimeout = timeouts.apiCall;

        groups.forEach(group => {
            console.log(`[MMM-Sonos] Registering polling for group "${group.Name}" (host "${group.host}")`);

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
                        console.error(`[MMM-Sonos] All polling calls failed for "${group.Name}" (${this.pollingFailureCounts[group.ID]}/${maxFailures})`);

                        if (this.pollingFailureCounts[group.ID] >= maxFailures) {
                            console.error(`[MMM-Sonos] Max consecutive failures reached for "${group.Name}". Triggering rediscovery...`);
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
                        if (!lastTrack || lastTrack.title !== track.title || lastTrack.artist !== track.artist) {
                            console.log(`[MMM-Sonos] [Group ${group.Name} - ${group.host}] Track changed to "${track.title}" by "${track.artist}"`);
                            lastTrack = track;
                            this.sendSocketNotification('SET_SONOS_CURRENT_TRACK', {
                                group,
                                track
                            });
                        }
                    } else {
                        console.error(`[MMM-Sonos] Failed to get current track for "${group.Name}": ${results[0].reason?.message || results[0].reason}`);
                    }

                    // Handle volume changes
                    if (results[1].status === 'fulfilled') {
                        const volume = results[1].value;
                        if (lastVolume !== volume) {
                            console.log(`[MMM-Sonos] [Group ${group.Name} - ${group.host}] Volume changed to "${volume}"`);
                            lastVolume = volume;
                            this.sendSocketNotification('SET_SONOS_VOLUME', {
                                group,
                                volume
                            });
                        }
                    } else {
                        console.error(`[MMM-Sonos] Failed to get volume for "${group.Name}": ${results[1].reason?.message || results[1].reason}`);
                    }

                    // Handle mute changes
                    if (results[2].status === 'fulfilled') {
                        const isMuted = results[2].value;
                        const currentIsMuted = isMuted ? 'muted' : 'unmuted';
                        if (lastMute !== currentIsMuted) {
                            console.log(`[MMM-Sonos] [Group ${group.Name} - ${group.host}] Group is ${currentIsMuted}`);
                            lastMute = currentIsMuted;
                            this.sendSocketNotification('SET_SONOS_MUTE', {
                                group,
                                isMuted
                            });
                        }
                    } else {
                        console.error(`[MMM-Sonos] Failed to get mute state for "${group.Name}": ${results[2].reason?.message || results[2].reason}`);
                    }

                    // Handle play state changes
                    if (results[3].status === 'fulfilled') {
                        const state = results[3].value;
                        if (lastState !== state) {
                            console.log(`[MMM-Sonos] [Group ${group.Name} - ${group.host}] Play state change to "${state}"`);
                            lastState = state;
                            this.sendSocketNotification('SET_SONOS_PLAY_STATE', {
                                group,
                                state
                            });
                        }
                    } else {
                        console.error(`[MMM-Sonos] Failed to get play state for "${group.Name}": ${results[3].reason?.message || results[3].reason}`);
                    }
                });
            }, pollingTimeout);

            this.pollingIntervals.push(intervalId);
        });
    },

    triggerPollingRediscovery: function() {
        // Prevent re-entrant calls
        if (this.isRediscovering) {
            console.debug('[MMM-Sonos] Rediscovery already in progress, skipping');
            return;
        }
        this.isRediscovering = true;

        console.log('[MMM-Sonos] Triggering rediscovery due to polling failures');

        // Clear all polling intervals
        this.pollingIntervals.forEach(id => clearInterval(id));
        this.pollingIntervals = [];
        this.pollingFailureCounts = {};

        // Clean up and rediscover
        this.asyncDevice = null;
        if (listener.isListening()) {
            listener.stopListener().catch(e => {
                console.error(`[MMM-Sonos] Failed to stop listener: ${e.message}`);
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

        groups.forEach(group => {
            console.log(`[MMM-Sonos] Registering listeners for group "${group.Name}" (host "${group.host}")`);

            const sonos = group.CoordinatorDevice();
            this.subscribedDevices.push(sonos);

            // Add error handler for this device
            sonos.on('error', error => {
                console.error(`[MMM-Sonos] [Group ${group.Name} - ${group.host}] Device error: ${error.message}`);
            });

            sonos.on('CurrentTrack', track => {
                console.log(`[MMM-Sonos] [Group ${group.Name} - ${group.host}] Track changed to "${track.title}" by "${track.artist}"`);
                this.sendSocketNotification('SET_SONOS_CURRENT_TRACK', {
                    group,
                    track
                });
            });

            sonos.on('Volume', volume => {
                console.log(`[MMM-Sonos] [Group ${group.Name} - ${group.host}] Volume changed to "${volume}"`);
                this.sendSocketNotification('SET_SONOS_VOLUME', {
                    group,
                    volume
                });
            });

            sonos.on('Muted', isMuted => {
                console.log(`[MMM-Sonos] [Group ${group.Name} - ${group.host}] Group is ${isMuted ? 'muted' : 'unmuted'}`);
                this.sendSocketNotification('SET_SONOS_MUTE', {
                    group,
                    isMuted
                });
            });

            sonos.on('PlayState', state => {
                console.log(`[MMM-Sonos] [Group ${group.Name} - ${group.host}] Play state change to "${state}"`);
                this.sendSocketNotification('SET_SONOS_PLAY_STATE', {
                    group,
                    state
                });
            });
        });

        // Note: No watchdog in events-only mode - it can't distinguish between
        // "events are broken" and "nothing is playing". Use hybrid mode for self-healing.
    },

    // Watchdog methods for hybrid mode - detects when polling stops receiving responses
    startWatchdog: function() {
        // Don't start watchdog in polling-only mode - it has its own failure detection
        if (this.config && this.config.listenWithPolling) {
            return;
        }

        this.stopWatchdog();
        this.lastUpdateTimestamp = Date.now();

        const watchdogInterval = this.config?.watchdogInterval || 60000;  // Check every 1 minute
        const maxSilentPeriod = this.config?.maxSilentPeriod || 300000;   // 5 minutes

        this.watchdogTimer = setInterval(() => {
            const timeSinceLastUpdate = Date.now() - this.lastUpdateTimestamp;
            const secondsSinceUpdate = Math.round(timeSinceLastUpdate / 1000);

            console.debug(`[MMM-Sonos] Watchdog check: ${secondsSinceUpdate}s since last update`);

            if (timeSinceLastUpdate > maxSilentPeriod) {
                console.warn(`[MMM-Sonos] No updates received for ${secondsSinceUpdate}s. Triggering rediscovery...`);
                this.triggerRediscovery();
            }
        }, watchdogInterval);

        console.log(`[MMM-Sonos] Watchdog started (check interval: ${watchdogInterval}ms, max silent period: ${maxSilentPeriod}ms)`);
    },

    stopWatchdog: function() {
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }
    },

    updateWatchdogTimestamp: function() {
        this.lastUpdateTimestamp = Date.now();
    },

    triggerRediscovery: function() {
        // Prevent re-entrant calls
        if (this.isRediscovering) {
            console.debug('[MMM-Sonos] Rediscovery already in progress, skipping');
            return;
        }
        this.isRediscovering = true;

        console.log('[MMM-Sonos] Triggering rediscovery due to watchdog timeout');
        this.stopWatchdog();

        // Clean up existing state
        this.subscribedDevices.forEach(device => {
            device.removeAllListeners('CurrentTrack');
            device.removeAllListeners('Volume');
            device.removeAllListeners('Muted');
            device.removeAllListeners('PlayState');
            device.removeAllListeners('error');
        });
        this.subscribedDevices = [];

        if (listener.isListening()) {
            listener.stopListener().catch(e => {
                console.error(`[MMM-Sonos] Failed to stop listener during rediscovery: ${e.message}`);
            });
        }

        this.asyncDevice = null;

        // Start fresh discovery after a short delay
        setTimeout(() => {
            this.isRediscovering = false;
            this.discoverGroups();
        }, 2000);
    },

    // Hybrid mode: events + background polling for maximum reliability
    setListenersHybrid: function(groups) {
        // Set up event listeners (same as setListeners but without starting watchdog yet)
        this.subscribedDevices.forEach(device => {
            device.removeAllListeners('CurrentTrack');
            device.removeAllListeners('Volume');
            device.removeAllListeners('Muted');
            device.removeAllListeners('PlayState');
            device.removeAllListeners('error');
        });
        this.subscribedDevices = [];

        // Clear any existing polling intervals
        this.pollingIntervals.forEach(id => clearInterval(id));
        this.pollingIntervals = [];

        groups.forEach(group => {
            console.log(`[MMM-Sonos] Registering hybrid listeners for group "${group.Name}" (host "${group.host}")`);

            const sonos = group.CoordinatorDevice();
            this.subscribedDevices.push(sonos);

            // Add error handler for this device
            sonos.on('error', error => {
                console.error(`[MMM-Sonos] [Group ${group.Name} - ${group.host}] Device error: ${error.message}`);
            });

            sonos.on('CurrentTrack', track => {
                this.updateWatchdogTimestamp();
                console.log(`[MMM-Sonos] [Group ${group.Name} - ${group.host}] Track changed to "${track.title}" by "${track.artist}"`);
                this.sendSocketNotification('SET_SONOS_CURRENT_TRACK', {
                    group,
                    track
                });
            });

            sonos.on('Volume', volume => {
                this.updateWatchdogTimestamp();
                console.log(`[MMM-Sonos] [Group ${group.Name} - ${group.host}] Volume changed to "${volume}"`);
                this.sendSocketNotification('SET_SONOS_VOLUME', {
                    group,
                    volume
                });
            });

            sonos.on('Muted', isMuted => {
                this.updateWatchdogTimestamp();
                console.log(`[MMM-Sonos] [Group ${group.Name} - ${group.host}] Group is ${isMuted ? 'muted' : 'unmuted'}`);
                this.sendSocketNotification('SET_SONOS_MUTE', {
                    group,
                    isMuted
                });
            });

            sonos.on('PlayState', state => {
                this.updateWatchdogTimestamp();
                console.log(`[MMM-Sonos] [Group ${group.Name} - ${group.host}] Play state change to "${state}"`);
                this.sendSocketNotification('SET_SONOS_PLAY_STATE', {
                    group,
                    state
                });
            });
        });

        // Set up background polling as backup (with change detection to avoid unnecessary re-renders)
        const backupPollingInterval = this.config?.hybridPollingInterval || 30000;
        const timeouts = this.config?.timeouts || DEFAULT_TIMEOUTS;
        const apiTimeout = timeouts.apiCall;

        console.log(`[MMM-Sonos] Hybrid mode: Setting up backup polling every ${backupPollingInterval}ms`);

        groups.forEach(group => {
            const sonos = group.CoordinatorDevice();

            // Track last known values to avoid sending duplicate updates
            let lastTrack = null;
            let lastVolume = null;
            let lastMute = null;
            let lastState = null;

            const intervalId = setInterval(() => {
                // Silently poll to verify and refresh data
                Promise.allSettled([
                    withTimeout(sonos.currentTrack(), apiTimeout),
                    withTimeout(sonos.getVolume(), apiTimeout),
                    withTimeout(sonos.getMuted(), apiTimeout),
                    withTimeout(sonos.getCurrentState(), apiTimeout)
                ]).then(results => {
                    // Update watchdog if at least one poll succeeded (proves connection is alive)
                    const anySucceeded = results.some(r => r.status === 'fulfilled');
                    if (anySucceeded) {
                        this.updateWatchdogTimestamp();
                    }

                    // Send updates only if data changed (acts as fallback if events are broken)
                    if (results[0].status === 'fulfilled' && results[0].value) {
                        const track = results[0].value;
                        if (!lastTrack || lastTrack.title !== track.title || lastTrack.artist !== track.artist) {
                            lastTrack = track;
                            this.sendSocketNotification('SET_SONOS_CURRENT_TRACK', {
                                group,
                                track
                            });
                        }
                    }

                    if (results[1].status === 'fulfilled') {
                        const volume = results[1].value;
                        if (lastVolume !== volume) {
                            lastVolume = volume;
                            this.sendSocketNotification('SET_SONOS_VOLUME', {
                                group,
                                volume
                            });
                        }
                    }

                    if (results[2].status === 'fulfilled') {
                        const isMuted = results[2].value;
                        if (lastMute !== isMuted) {
                            lastMute = isMuted;
                            this.sendSocketNotification('SET_SONOS_MUTE', {
                                group,
                                isMuted
                            });
                        }
                    }

                    if (results[3].status === 'fulfilled') {
                        const state = results[3].value;
                        if (lastState !== state) {
                            lastState = state;
                            this.sendSocketNotification('SET_SONOS_PLAY_STATE', {
                                group,
                                state
                            });
                        }
                    }
                });
            }, backupPollingInterval);

            this.pollingIntervals.push(intervalId);
        });

        // Start the watchdog
        this.startWatchdog();
    },

    handleTogglePlayPause: function(groupId) {
        const group = this.groupsById[groupId];
        if (!group) {
            console.error(`[MMM-Sonos] Group not found for ID: ${groupId}`);
            return;
        }

        const sonos = group.CoordinatorDevice();
        sonos.togglePlayback()
            .then(() => {
                console.log(`[MMM-Sonos] Toggle play/pause for group: ${group.Name}`);
            })
            .catch(error => {
                console.error(`[MMM-Sonos] Failed to toggle playback: ${error.message}`);
            });
    },

    handleNext: function(groupId) {
        const group = this.groupsById[groupId];
        if (!group) {
            console.error(`[MMM-Sonos] Group not found for ID: ${groupId}`);
            return;
        }

        const sonos = group.CoordinatorDevice();
        sonos.next()
            .then(() => {
                console.log(`[MMM-Sonos] Skip to next for group: ${group.Name}`);
            })
            .catch(error => {
                console.error(`[MMM-Sonos] Failed to skip track: ${error.message}`);
            });
    },

    handleSetVolume: function(groupId, volume) {
        const group = this.groupsById[groupId];
        if (!group) {
            console.error(`[MMM-Sonos] Group not found for ID: ${groupId}`);
            return;
        }

        // Validate volume range
        volume = Math.max(0, Math.min(100, parseInt(volume, 10)));
        if (isNaN(volume)) {
            console.error(`[MMM-Sonos] Invalid volume value`);
            return;
        }

        const sonos = group.CoordinatorDevice();
        sonos.setVolume(volume)
            .then(() => {
                console.log(`[MMM-Sonos] Set volume to ${volume} for group: ${group.Name}`);
            })
            .catch(error => {
                console.error(`[MMM-Sonos] Failed to set volume: ${error.message}`);
            });
    }
});