import { Server } from 'lucide-react';
import { defineModule, tmStatic, useT } from '@sfera/sdk';
import { ServerSelector } from './ServerSelector';
import { AuthServerPicker } from '../../../components/AuthServerPicker';

function ServersSettings() {
  const tr = useT();
  return (
    <section>
      <h1><Server size={20} style={{ verticalAlign: 'middle', marginRight: 8 }} />{tr('srv_title')}</h1>
      <p>{tr('srv_desc')}</p>
      <ServerSelector />
    </section>
  );
}

export default defineModule({
  id: 'multiserver',
  setup(ctx) {
    ctx.slot('auth.footer', { id: 'server-picker', render: AuthServerPicker });
    ctx.slot('settings.page', { id: 'servers', label: () => tmStatic('settings_servers'), render: ServersSettings });
  },
});
