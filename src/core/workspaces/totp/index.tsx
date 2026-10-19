import { ShieldCheck } from 'lucide-react';
import { defineModule, tmStatic } from '@sfera/sdk';
import { Gate } from './Gate';
import { SettingsPage } from './SettingsPage';
import { strings } from './i18n';

export default defineModule({
  id: 'totp',
  setup(ctx) {
    ctx.strings(strings);
    ctx.slot('settings.page', {
      id: 'totp',
      label: () => tmStatic('tf_title'),
      icon: <ShieldCheck size={16} />,
      render: SettingsPage,
    });
    // The blocking screen. The real block is the server's — this only tells the
    // person what to do about it.
    ctx.slot('app.overlay', { id: 'totp-gate', render: Gate });
  },
});
