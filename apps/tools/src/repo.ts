// Where this build came from: the GitHub repository (owner/name, set by the build from GITHUB_REPOSITORY), its
// releases, its Pages site, and the add-on repository the Kurokawa apps share (repo/ in it).
export const REPO: string = typeof __REPO_SLUG__ === 'string' ? __REPO_SLUG__ : 'YoRu72/KurokawaReader';
export const REPO_OWNER = REPO.split('/')[0];
export const REPO_NAME = REPO.split('/')[1];
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
/** The Pages site: the reader at its root, this app under tools/. */
export const SITE_URL = `https://${REPO_OWNER.toLowerCase()}.github.io/${REPO_NAME}/`;
export const WEB_APP_URL = `${SITE_URL}tools/`;
/** Releases of this app carry tags tools-v<version>; the reader's are v<version>. */
export const TAG_PREFIX = 'tools-v';
export const addonUrl = (path: string): string => `https://raw.githubusercontent.com/${REPO}/main/repo/${path}`;
