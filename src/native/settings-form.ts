// settings-form.ts — settings window entry: theme/accent sync + tab wiring.
import { initTheme, type ThemePref } from '../state/theme';
import { initAccent } from '../state/accent';
import { initTabs } from './settings/tabs';
import { initInferenceTab } from './settings/inference-tab';
import { initGeneralTab } from './settings/general-tab';

// `initGeneralTab()` (below) builds the theme radios and returns the
// callback that reflects an external pref change into them, but it must
// run after `initTabs`/DOM is ready. `initTheme` wants that listener at
// call time, so this indirection captures it once `initGeneralTab` runs —
// any external change (main-window switcher, another window's `storage`
// event) before that point simply has nothing to reflect into yet.
let reflectThemeRadios: ((pref: ThemePref) => void) | undefined;
initTheme((pref) => reflectThemeRadios?.(pref));
initAccent();
initTabs(document.body);
initInferenceTab();
reflectThemeRadios = initGeneralTab();
