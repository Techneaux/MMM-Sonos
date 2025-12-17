# MagicMirror Module: Sonos

`MMM-Sonos` is a module for [MagicMirror](https://github.com/MichMich/MagicMirror) that allows you to display playing tracks on your Sonos network.
It support the display of different rooms and track information.

![Screenshot of the Sonos module](./screenshot.png)

## Usage

### Setup

Clone this module into your MagicMirror's `modules` directory and install dependencies:

```sh
cd modules
git clone https://github.com/tbouron/MMM-Sonos
cd MMM-Sonos
npm i
```

then add the module to your MagicMirror's configuration. Here is an example:

```javascript
/* MagicMirror/config/config.js */
{
    /* ...your other config here */

    modules: [

        /* ...your other modules here */

        {
            module: 'MMM-Sonos',
            header: 'Now playing',
            position: 'top_left',
            config: {
                animationSpeed: Number,
                showFullGroupName: Boolean,
                showArtist: Boolean,
                showAlbum: Boolean,
                showMetadata: Boolean,
                rooms: ['Kitchen', 'Living Room']
            }
        }
    ]
}
```

### Configuration options

| Configuration key | Description | Default | Required |
| --- | --- | --- | --- |
| animationSpeed | Animation speed to display/hide the module when tracks change. This value is in _milliseconds_ | 1000 | No |
| showFullGroupName | Whether or not to display all devices in the group. If false, the group name will be `<coordinator-name> +<number-other-devices>`, e.g. `Kitchen +2`. | `false` | No |
| showArtist | Whether or not to display the artist name | `true` | No |
| showAlbum | Whether or not to display the album name | `true` | No |
| showMetadata | Whether or not to display the track metadata, i.e. room where it's played, length, volume | `true` | No |
| listenWithPolling | When the default events won't work with the sonos, it is possible to poll the data | `false` | No |
| pollingTimeout | Polling timeout in milliseconds, only works when `listenWithPolling` is set to `true` | 5000 | No |
| rooms | Array of room names to display. If empty, all rooms are shown. Case-insensitive. When speakers are grouped, the group is shown if any member matches. | `[]` | No |

### Reliability Options

These options help prevent the module from silently stopping updates due to network issues or Sonos device problems.

| Configuration key | Description | Default | Required |
| --- | --- | --- | --- |
| hybridMode | Use events + background polling for reliable self-healing. Recommended. | `true` | No |
| hybridPollingInterval | Backup polling interval in hybrid mode (milliseconds) | 30000 | No |
| watchdogInterval | How often to check for polling silence in hybrid mode (milliseconds) | 60000 | No |
| maxSilentPeriod | How long without successful polls before triggering rediscovery (milliseconds) | 300000 | No |
| maxConsecutiveFailures | In polling-only mode, how many consecutive failures before rediscovery | 5 | No |
| timeouts | Object with timeout values for API calls (see below) | See defaults | No |

#### Listening Modes

- **Hybrid mode** (default, `hybridMode: true`): Uses events for instant updates, plus background polling every 30s to verify the connection is working. If no updates are received for 5 minutes, triggers automatic rediscovery. **Recommended for most users.**

- **Events-only mode** (`hybridMode: false`): Uses only UPnP event subscriptions. More efficient but cannot automatically recover if events silently stop working.

- **Polling-only mode** (`listenWithPolling: true`): Polls Sonos devices at regular intervals. Use if events are consistently unreliable on your network.

**Note:** If multiple modes are configured, precedence is: polling-only > hybrid > events-only.

#### Timeout Configuration

The `timeouts` option accepts an object with the following keys:

```javascript
timeouts: {
    discovery: 10000,    // Timeout for device discovery (ms)
    subscribe: 5000,     // Timeout for listener subscription (ms)
    apiCall: 5000,       // Timeout for regular API calls (ms)
    getAllGroups: 10000  // Timeout for getting all groups (ms)
}
```

### Troubleshooting

**Module stops updating but doesn't crash:**
With the default hybrid mode, the module will automatically recover within 5 minutes. If you want faster recovery:
1. Reduce `maxSilentPeriod` (e.g., 120000 for 2 minutes)
2. Reduce `hybridPollingInterval` for more frequent checks

**Frequent rediscovery cycles:**
If you see many "Triggering rediscovery" messages in the logs, your Sonos devices may have intermittent connectivity. Try:
1. Increasing `maxSilentPeriod` to reduce false positives
2. Checking your network stability
3. Ensuring Sonos devices have strong WiFi signal
