// settings-form.ts — settings window entry: theme/accent sync + tab wiring.
import { initTheme } from '../state/theme';
import { initAccent } from '../state/accent';
import { initAnchorVisibility } from '../state/anchor-visibility';
import { initTabs } from './settings/tabs';
import { initInferenceTab } from './settings/inference-tab';
import { initGeneralTab } from './settings/general-tab';
import { initPromptTab } from './settings/prompt-tab';

// `settings.html` loads this script as `type="module" defer`, so the DOM
// (including the static `#theme-group` markup) is already fully parsed
// before any of this runs. `initGeneralTab()` builds the theme radios and
// accent swatches and returns the callbacks that reflect an external pref
// change into them; call it first and hand each callback straight to its
// state module's init function.
const { reflectTheme, reflectAccent } = initGeneralTab();
initTheme(reflectTheme);
initAccent(reflectAccent);
initAnchorVisibility();
initTabs(document.body);
initInferenceTab();
void initPromptTab();
