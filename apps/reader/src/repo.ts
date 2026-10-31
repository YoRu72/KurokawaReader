// Where this build came from: the GitHub repository (owner/name, set by the build from GITHUB_REPOSITORY), its
// releases and its Pages site. Nothing imported here, so any module may read it as it loads.
export const REPO: string = typeof __REPO_SLUG__ === 'string' ? __REPO_SLUG__ : 'YoRu72/KurokawaReader';
export const REPO_OWNER = REPO.split('/')[0];
export const REPO_NAME = REPO.split('/')[1];
export const WEB_APP_URL = `https://${REPO_OWNER.toLowerCase()}.github.io/${REPO_NAME}/`;
/** The add-on repository the apps share (repo/ in the repository), a file of it by its path. */
export const addonUrl = (path: string): string => `https://raw.githubusercontent.com/${REPO}/main/repo/${path}`;
