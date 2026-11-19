import { defineModule, tmStatic } from '@sfera/sdk';
import { FamilySettings } from './FamilySettings';

export default defineModule({
  id: 'family',
  setup(ctx) {
    ctx.strings({
      ru: { family_settings: 'Семья' },
      en: { family_settings: 'Family' },
    });
    ctx.slot('settings.page', { id: 'family', label: () => tmStatic('family_settings'), render: FamilySettings });
  },
});
