import { defineModule } from '@sfera/sdk';
import { CreateDiaryCard, DiaryConnector, DiaryRail, DiaryRoute, ROUTE } from './components';
import * as diary from './store';
import { strings } from './i18n';

export default defineModule({
  id: 'diary',
  setup(ctx) {
    ctx.strings(strings);
    ctx.slot('app.provider', { id: 'connector', render: DiaryConnector });
    ctx.slot('nav.rail', { id: 'diaries', order: 20, render: DiaryRail });
    ctx.slot('explore.card', { id: 'create', order: 0, render: CreateDiaryCard });
    ctx.slot('main.view', {
      id: 'diary',
      match: route => route.currentServer.startsWith(`${ROUTE}:`),
      render: DiaryRoute,
    });
    ctx.onWs('signaling', 'module:diary.entry', f => diary.onRemoteEntry(f as never));
    ctx.onWs('signaling', 'module:diary.entry_updated', f => diary.onRemoteEntry(f as never));
    ctx.onWs('signaling', 'module:diary.entry_deleted', f => diary.onRemoteDeleted(f as never));
    ctx.onWs('signaling', 'module:diary.changed', () => diary.onRemoteChanged());
    // The diary tail cache is plain text on the device: drop it on sign-out.
    ctx.onLifecycle('logout', () => diary.clearCache());
    ctx.onDispose(() => diary.connect(null));
  },
});
