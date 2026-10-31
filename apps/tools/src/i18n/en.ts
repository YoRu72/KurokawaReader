// English strings of Kurokawa Tools (the fallback for every language).
export const en = {
  appName: 'Kurokawa Tools',
  tagline: 'Downloads, torrents, streaming — and the tools around them.',
  // Navigation
  navDownloads: 'Downloads', navSearch: 'Search', navLibrary: 'Library', navSettings: 'Settings',
  back: 'Back', close: 'Close', cancel: 'Cancel', done: 'Done', save: 'Save', remove: 'Remove', retry: 'Try again', open: 'Open', openFolder: 'Open folder', copy: 'Copy', copied: 'Copied', paste: 'Paste', share: 'Share', more: 'More', loading: 'Loading…', noResults: 'No results', search: 'Search', later: 'Later', ok: 'OK', yes: 'Yes', no: 'No',
  // Downloads
  downloadsEmptyTitle: 'Nothing here yet', downloadsEmptyBody: 'Add a link, a magnet or a .torrent file with +, or search the sources of your add-ons.',
  addDownload: 'Add a download', addHint: 'A link (http, https, ftp), a magnet link, or several on separate lines.', pickTorrentFile: 'Choose a .torrent file', pasteLink: 'Paste from the clipboard',
  addTitle: 'New download', addStart: 'Download', addAdvanced: 'Options', saveTo: 'Save to', changeFolder: 'Change', fileName: 'File name', connections: 'Connections', sequential: 'Download in order (play while it comes)', startPaused: 'Start paused', pickFiles: 'Choose files', allFiles: 'All files', selectedFiles: '{n} of {total} chosen', fetchingMetadata: 'Getting the torrent’s details…',
  stateQueued: 'Waiting', stateMetadata: 'Getting metadata', stateDownloading: 'Downloading', stateSeeding: 'Seeding', statePaused: 'Paused', stateDone: 'Done', stateFailed: 'Failed', stateChecking: 'Checking',
  speedDown: '↓ {s}', speedUp: '↑ {s}', perSecond: '{n}/s', etaLeft: '{t} left', peersSeeds: '{peers} peers · {seeds} seeds',
  pause: 'Pause', resume: 'Resume', pauseAll: 'Pause all', resumeAll: 'Resume all', removeTask: 'Remove', removeWithFiles: 'Remove and delete the files', removeKeepFiles: 'Remove from the list only', clearDone: 'Clear finished', play: 'Play', stream: 'Play while downloading', details: 'Details', copyMagnet: 'Copy the magnet link', copyLink: 'Copy the link',
  filterAll: 'All', filterActive: 'Active', filterDone: 'Finished', filterFailed: 'Failed', sortAdded: 'Newest first', sortName: 'By name', sortProgress: 'By progress',
  taskAdded: '“{name}” added', taskRemoved: 'Removed', tasksRemoved: '{n} removed', taskFailed: 'Download failed: {error}', noEngine: 'This platform has no download engine of its own here; set up a remote aria2 in Settings, or use the Android or desktop app.', engineUnavailable: 'The download engine is not available: {why}',
  filesTitle: 'Files', fileSkip: 'Skip', fileNormal: 'Download', fileHigh: 'First',
  // Settings
  settings: 'Settings', general: 'General', language: 'Language', languageSystem: 'Follow the system', appearance: 'Appearance', uiMode: 'Theme', uiSystem: 'System', uiLight: 'Light', uiDark: 'Dark', darkTone: 'Dark background', darkToneDefault: 'Default', darkToneGrey: 'Grey', darkToneBlack: 'Black (OLED)', accent: 'Accent colour',
  downloadsSection: 'Downloads', downloadFolder: 'Download folder', defaultFolder: 'The app’s folder', maxActive: 'Downloads at once', speedLimits: 'Speed limits', downLimit: 'Download limit', upLimit: 'Upload limit', unlimited: 'Unlimited', seedAfterDone: 'Keep seeding when done', listenPort: 'Listening port', portRandom: 'Random',
  remoteAria2: 'Remote aria2', remoteAria2Hint: 'Send downloads to an aria2 running elsewhere (a server, a NAS, a PC) through its JSON-RPC.', aria2Url: 'RPC address', aria2Secret: 'Secret token', aria2Use: 'Use it for downloads', aria2Test: 'Test the connection', aria2Ok: 'Connected to aria2 {v}', aria2Fail: 'Could not reach aria2: {error}',
  addons: 'Add-ons', addonsHint: 'Everything beyond plain downloads — torrent search, anime, subtitles, debrid, archives — comes as an add-on from the Kurokawa repository. Install only what you use.', addonInstalled: 'Installed', addonInstall: 'Install', addonUpdate: 'Update', addonRemove: 'Remove', addonsRefresh: 'Refresh the list', addonsNone: 'No add-ons are published yet.', addonsFailed: 'The repository could not be read: {error}', addonChildren: 'Includes', addonSettings: 'Add-on settings', addonInstalledToast: '“{name}” installed', addonRemovedToast: '“{name}” removed',
  otherApps: 'Other Kurokawa apps', otherAppsHint: 'The apps share one look, one AniList link and one repository of add-ons.', appReader: 'KurokawaReader', appReaderDesc: 'An offline reader for EPUB, PDF, Word, comics and more, with sources and a converter.', appInstalled: 'Installed · open', appGet: 'Get it', appDownloadApk: 'Download the APK', appOpenReleases: 'Open the releases page',
  updates: 'App updates', checkUpdates: 'Check for updates', checking: 'Checking…', upToDate: 'Up to date', updateAvailable: 'Update available: {v}', updateAvailableShort: 'Version {v} is available', updateNow: 'Update', autoCheck: 'Check automatically when online', downloadInstall: 'Download and install', downloading: 'Downloading… {p}%', installStarted: 'The installer was opened', updateFailed: 'Could not check for updates', whatsNew: 'What’s new', lastChecked: 'Last checked: {d}', openReleasePage: 'Open the release page', updateReady: 'The update is downloaded', restartNow: 'Restart now', version: 'Version {v}',
  about: 'About', aboutBody: 'Kurokawa Tools downloads from the web and from torrents, plays what it gets, and grows by add-ons. Nothing leaves your device but the requests you make.', sourceCode: 'Source code', reportIssue: 'Report a problem', licenses: 'Open-source licences',
  privacy: 'Privacy', incognito: 'Incognito: no history', clearHistory: 'Clear history',
  notifications: 'Notifications', notifyDone: 'When a download finishes', notifyFailed: 'When a download fails',
  // Install (APK)
  installApk: 'Install', installing: 'Installing…', installDone: 'Installed', installFailed: 'Install failed: {error}', installPermission: 'Allow Kurokawa Tools to install apps on the page that opens, then come back.',
  // Misc
  todayAt: 'Today {t}', yesterday: 'Yesterday', bytesOf: '{done} of {total}', nothingToPaste: 'The clipboard holds no link', invalidLink: 'That is not a link, a magnet or a torrent', folderPicked: 'Downloads go to {dir}', confirmRemoveFiles: 'Delete the downloaded files of “{name}” too?',
} as const;

export type Strings = { -readonly [K in keyof typeof en]: string };
