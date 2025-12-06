Module.register('MMM-Sonos', {
    defaults: {
        animationSpeed: 1000,
        showFullGroupName: false,
        showArtist: true,
        showAlbum: true,
        showMetadata: true,
        listenWithPolling: false,
        pollingTimeout: 5000,
        rooms: [],
    },

    items: {},
    isModalOpen: false,
    currentGroupId: null,
    modalElement: null,
    volumeDebounceTimer: null,

    start: function () {
        Log.log('Sonos frontend started');
        this.sendSocketNotification('SONOS_START', {
            listenWithPolling: this.config.listenWithPolling,
            pollingTime: this.config.pollingTimeout ?? 5000,
            rooms: this.config.rooms,
        });
    },

    getStyles: function () {
        return ['MMM-Sonos.css'];
    },

    getScripts: function () {
        return [this.file('node_modules/feather-icons/dist/feather.min.js')];
    },

    socketNotificationReceived: function (id, payload) {
        Log.log(`Notification received: ${id}`, payload);

        switch (id) {
            case 'SET_SONOS_GROUPS':
                this.items = payload;
                this.updateDom(this.config.animationSpeed);
                break;
            case 'SET_SONOS_CURRENT_TRACK':
                if (this.items.hasOwnProperty(payload.group.ID)) {
                    this.items[payload.group.ID] = {
                        ...this.items[payload.group.ID],
                        group: payload.group,
                        track: payload.track,
                    };
                    this.updateDom(this.config.animationSpeed);
                }
                break;
            case 'SET_SONOS_VOLUME':
                if (this.items.hasOwnProperty(payload.group.ID)) {
                    this.items[payload.group.ID] = {
                        ...this.items[payload.group.ID],
                        group: payload.group,
                        volume: payload.volume
                    };
                    this.updateDom();
                }
                break;
            case 'SET_SONOS_MUTE':
                if (this.items.hasOwnProperty(payload.group.ID)) {
                    this.items[payload.group.ID] = {
                        ...this.items[payload.group.ID],
                        group: payload.group,
                        isMuted: payload.isMuted
                    };
                    this.updateDom();
                }
                break;
            case 'SET_SONOS_PLAY_STATE':
                if (this.items.hasOwnProperty(payload.group.ID)) {
                    this.items[payload.group.ID] = {
                        ...this.items[payload.group.ID],
                        group: payload.group,
                        state: payload.state
                    };
                    this.updateDom(this.config.animationSpeed);
                }
                break;
            default:
                Log.info(`Notification with ID "${id}" unsupported. Ignoring...`);
                break;
        }
    },

    getHeader: function () {
        if (this.data.header && Object.values(this.items).some(item => item.state === 'playing' && item.track)) {
            return this.data.header;
        }
    },

    getDom: function () {
        const self = this;

        if (Object.values(this.items).length === 0) {
            return document.createElement('div');
        }

        const container = document.createElement('div');
        container.className = 'sonos light';
        container.append(...Object.values(this.items)
            .filter(item => item.state === 'playing' && item.track)
            .map(item => {
                const groupContainer = document.createElement('div');
                groupContainer.className = 'sonos-group clickable';
                groupContainer.dataset.groupId = item.group.ID;

                // Add click handler to open modal
                groupContainer.addEventListener('click', function(event) {
                    event.stopPropagation();
                    self.openSonosModal(item.group.ID);
                });

                const track = document.createElement('div');
                track.className = 'track';
                track.innerHTML = `<strong class="bright ticker">${item.track.title}</strong>`;
                groupContainer.append(track);

                const artist = [];
                if (this.config.showArtist && item.track.artist) {
                    artist.push(`<span class="bright">${item.track.artist}</span>`);
                }
                if (this.config.showAlbum && item.track.album) {
                    artist.push(`${item.track.album}`);
                }
                if (artist.length > 0) {
                    const artistElement = document.createElement('div');
                    artistElement.className = 'artist small ticker';
                    artistElement.innerHTML = artist.join('&nbsp;○&nbsp;');
                    groupContainer.append(artistElement);
                }

                if (this.config.showMetadata) {
                    let volume;
                    if (item.isMuted === true) {
                        volume = `${this.getIcon('volume-x', 'dimmed')}`;
                    } else {
                        volume = `${this.getIcon(item.volume < 50 ? 'volume-1' : 'volume-2', 'dimmed')}&nbsp;<span>${item.volume}</span>`;
                    }

                    const groupName = this.config.showFullGroupName
                        ? item.group.ZoneGroupMember.map(member => member.ZoneName).join(' + ')
                        : item.group.Name;

                    const metadata = document.createElement('div');
                    metadata.className = 'metadata small normal';
                    metadata.innerHTML =
                        `<span>${this.getIcon('speaker', 'dimmed')}&nbsp;<span class="group-name ticker">${groupName}</span></span>` +
                        '&nbsp;' +
                        `<span>${volume}</span>` +
                        '&nbsp;' +
                        `<span>${this.getIcon('activity', 'dimmed')}&nbsp;<span>${Math.floor(item.track.duration / 60)}:${Math.ceil(item.track.duration % 60).toString().padStart(2, '0')}</span></span>`;
                    groupContainer.append(metadata);
                }

                return groupContainer;
            }));

        // Create modal if not exists
        if (!this.modalElement) {
            this.modalElement = this.createSonosModal();
        }

        // Update modal if open and data changed
        if (this.isModalOpen && this.currentGroupId && this.items[this.currentGroupId]) {
            const currentItem = this.items[this.currentGroupId];
            const id = this.identifier;

            // Update track info in modal
            const trackEl = document.querySelector(`#sonos-modal-track-${id}`);
            if (trackEl && currentItem.track) {
                trackEl.textContent = currentItem.track.title;
            }

            const artistEl = document.querySelector(`#sonos-modal-artist-${id}`);
            if (artistEl && currentItem.track) {
                artistEl.textContent = currentItem.track.artist || 'Unknown Artist';
            }

            const albumEl = document.querySelector(`#sonos-modal-album-${id}`);
            if (albumEl && currentItem.track) {
                albumEl.textContent = currentItem.track.album || 'Unknown Album';
            }

            // Update play/pause icon
            this.updatePlayPauseIcon(currentItem.state);

            // Update volume (only if slider not being dragged)
            const slider = document.querySelector(`#sonos-modal-volume-slider-${id}`);
            if (slider && document.activeElement !== slider) {
                slider.value = currentItem.volume;
                const volumeValue = document.querySelector(`#sonos-modal-volume-value-${id}`);
                if (volumeValue) volumeValue.textContent = currentItem.volume;
            }

            this.updateVolumeIcon(currentItem.isMuted, currentItem.volume);
        }

        return container;
    },

    getIcon: function (iconId, classes) {
        return `<svg class="feather ${classes}"><use xlink:href="${this.file('node_modules/feather-icons/dist/feather-sprite.svg')}#${iconId}"/></svg>`;
    },

    createSonosModal: function() {
        const self = this;
        const id = this.identifier;

        // Create modal container (backdrop)
        const modal = document.createElement('div');
        modal.id = `sonos-modal-${id}`;
        modal.className = 'sonos-modal hidden';

        // Modal content wrapper
        const modalContent = document.createElement('div');
        modalContent.className = 'sonos-modal-content';

        // Track title
        const trackTitle = document.createElement('h3');
        trackTitle.id = `sonos-modal-track-${id}`;
        trackTitle.className = 'sonos-modal-title';

        // Details container
        const detailsContainer = document.createElement('div');
        detailsContainer.className = 'sonos-modal-details';

        // Artist row
        const artistRow = document.createElement('div');
        artistRow.className = 'sonos-modal-row';
        artistRow.innerHTML = `<span class="sonos-modal-label">Artist:</span><span id="sonos-modal-artist-${id}" class="sonos-modal-value"></span>`;

        // Album row
        const albumRow = document.createElement('div');
        albumRow.className = 'sonos-modal-row';
        albumRow.innerHTML = `<span class="sonos-modal-label">Album:</span><span id="sonos-modal-album-${id}" class="sonos-modal-value"></span>`;

        // Room row
        const roomRow = document.createElement('div');
        roomRow.className = 'sonos-modal-row';
        roomRow.innerHTML = `<span class="sonos-modal-label">Room:</span><span id="sonos-modal-room-${id}" class="sonos-modal-value"></span>`;

        detailsContainer.appendChild(artistRow);
        detailsContainer.appendChild(albumRow);
        detailsContainer.appendChild(roomRow);

        // Controls container
        const controlsContainer = document.createElement('div');
        controlsContainer.className = 'sonos-modal-controls';

        // Play/Pause button
        const playPauseBtn = document.createElement('button');
        playPauseBtn.id = `sonos-modal-playpause-${id}`;
        playPauseBtn.className = 'sonos-modal-btn sonos-modal-btn-control';
        playPauseBtn.innerHTML = this.getIcon('play', '');
        playPauseBtn.addEventListener('click', function() {
            self.togglePlayPause();
        });

        // Next button
        const nextBtn = document.createElement('button');
        nextBtn.className = 'sonos-modal-btn sonos-modal-btn-control';
        nextBtn.innerHTML = this.getIcon('skip-forward', '');
        nextBtn.addEventListener('click', function() {
            self.skipToNext();
        });

        controlsContainer.appendChild(playPauseBtn);
        controlsContainer.appendChild(nextBtn);

        // Volume container
        const volumeContainer = document.createElement('div');
        volumeContainer.className = 'sonos-modal-volume';

        const volumeIcon = document.createElement('span');
        volumeIcon.id = `sonos-modal-volume-icon-${id}`;
        volumeIcon.innerHTML = this.getIcon('volume-2', '');

        const volumeSlider = document.createElement('input');
        volumeSlider.type = 'range';
        volumeSlider.id = `sonos-modal-volume-slider-${id}`;
        volumeSlider.className = 'sonos-modal-slider';
        volumeSlider.min = '0';
        volumeSlider.max = '100';
        volumeSlider.value = '50';
        volumeSlider.addEventListener('input', function(e) {
            self.setVolume(parseInt(e.target.value, 10));
        });

        const volumeValue = document.createElement('span');
        volumeValue.id = `sonos-modal-volume-value-${id}`;
        volumeValue.className = 'sonos-modal-volume-text';
        volumeValue.textContent = '50';

        volumeContainer.appendChild(volumeIcon);
        volumeContainer.appendChild(volumeSlider);
        volumeContainer.appendChild(volumeValue);

        // Assemble modal content
        modalContent.appendChild(trackTitle);
        modalContent.appendChild(detailsContainer);
        modalContent.appendChild(controlsContainer);
        modalContent.appendChild(volumeContainer);

        modal.appendChild(modalContent);

        // Click outside to close
        modal.addEventListener('click', function(event) {
            if (!event.target.closest('.sonos-modal-content')) {
                self.closeSonosModal();
            }
        });

        return modal;
    },

    openSonosModal: function(groupId) {
        const item = this.items[groupId];
        if (!item) return;

        this.isModalOpen = true;
        this.currentGroupId = groupId;

        const id = this.identifier;
        const modal = this.modalElement;

        if (!modal) return;

        // Ensure modal is in document.body for fixed positioning
        if (modal.parentNode !== document.body) {
            document.body.appendChild(modal);
        }

        // Populate track info
        modal.querySelector(`#sonos-modal-track-${id}`).textContent =
            item.track ? item.track.title : 'Unknown Track';
        modal.querySelector(`#sonos-modal-artist-${id}`).textContent =
            item.track ? (item.track.artist || 'Unknown Artist') : 'Unknown';
        modal.querySelector(`#sonos-modal-album-${id}`).textContent =
            item.track ? (item.track.album || 'Unknown Album') : 'Unknown';

        // Room name
        const groupName = this.config.showFullGroupName
            ? item.group.ZoneGroupMember.map(m => m.ZoneName).join(' + ')
            : item.group.Name;
        modal.querySelector(`#sonos-modal-room-${id}`).textContent = groupName;

        // Update play/pause button icon
        this.updatePlayPauseIcon(item.state);

        // Update volume slider
        const volumeSlider = modal.querySelector(`#sonos-modal-volume-slider-${id}`);
        const volumeValue = modal.querySelector(`#sonos-modal-volume-value-${id}`);
        volumeSlider.value = item.volume || 50;
        volumeValue.textContent = item.volume || 50;

        // Update volume icon based on mute state
        this.updateVolumeIcon(item.isMuted, item.volume);

        // Show modal
        modal.classList.remove('hidden');
    },

    closeSonosModal: function() {
        const modal = this.modalElement;
        if (modal) {
            modal.classList.add('hidden');
        }
        this.isModalOpen = false;
        this.currentGroupId = null;
    },

    updatePlayPauseIcon: function(state) {
        const id = this.identifier;
        const btn = document.querySelector(`#sonos-modal-playpause-${id}`);
        if (btn) {
            const iconName = (state === 'playing') ? 'pause' : 'play';
            btn.innerHTML = this.getIcon(iconName, '');
        }
    },

    updateVolumeIcon: function(isMuted, volume) {
        const id = this.identifier;
        const icon = document.querySelector(`#sonos-modal-volume-icon-${id}`);
        if (icon) {
            const iconName = isMuted ? 'volume-x' : (volume < 50 ? 'volume-1' : 'volume-2');
            icon.innerHTML = this.getIcon(iconName, '');
        }
    },

    togglePlayPause: function() {
        if (!this.currentGroupId) return;
        this.sendSocketNotification('SONOS_TOGGLE_PLAY_PAUSE', {
            groupId: this.currentGroupId
        });
    },

    skipToNext: function() {
        if (!this.currentGroupId) return;
        this.sendSocketNotification('SONOS_NEXT', {
            groupId: this.currentGroupId
        });
    },

    setVolume: function(volume) {
        if (!this.currentGroupId) return;

        // Update UI immediately for responsiveness
        const id = this.identifier;
        const volumeValue = document.querySelector(`#sonos-modal-volume-value-${id}`);
        if (volumeValue) {
            volumeValue.textContent = volume;
        }

        // Use actual mute state instead of hardcoded false
        const currentItem = this.items[this.currentGroupId];
        const isMuted = currentItem ? currentItem.isMuted : false;
        this.updateVolumeIcon(isMuted, volume);

        // Debounce API call to prevent flooding Sonos device
        const self = this;
        if (this.volumeDebounceTimer) {
            clearTimeout(this.volumeDebounceTimer);
        }
        this.volumeDebounceTimer = setTimeout(function() {
            self.sendSocketNotification('SONOS_SET_VOLUME', {
                groupId: self.currentGroupId,
                volume: volume
            });
        }, 200);
    },

    suspend: function() {
        // Close modal and remove from DOM when module is hidden
        if (this.modalElement && this.modalElement.parentNode === document.body) {
            document.body.removeChild(this.modalElement);
        }
        this.modalElement = null;  // Clear reference to ensure proper recreation
        this.closeSonosModal();
    }
});