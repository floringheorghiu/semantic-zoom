// settings-form.ts — settings window entry: theme/accent sync + tab wiring.
import { initTheme } from '../state/theme';
import { initAccent } from '../state/accent';
import { initTabs } from './settings/tabs';
import { initInferenceTab } from './settings/inference-tab';
import { initGeneralTab } from './settings/general-tab';

// `settings.html` loads this script as `type="module" defer`, so the DOM
// (including the static `#theme-group` markup) is already fully parsed
// before any of this runs. `initGeneralTab()` builds the theme radios and
// returns the callback that reflects an external pref change into them;
// call it first and hand the callback straight to `initTheme()`.
const reflectRadios = initGeneralTab();
initTheme((pref) => reflectRadios(pref));
initAccent();
initTabs(document.body);
initInferenceTab();
