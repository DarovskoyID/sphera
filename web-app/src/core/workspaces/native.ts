import type { SferaModule } from '../../sdk/defineModule';
import type { ModuleInfo } from '../modules/registry';
export const NATIVE_LOADERS: Record<string, () => Promise<{ default: SferaModule }>> = {
  office: () => import('./office/index'),
  whiteboard: () => import('./whiteboard/index'),
  planner: () => import('./planner/index'),
  conference: () => import('./conference/index'),
  servers: () => import('./servers/index'),
  channels: () => import('./channels/index'),
  bots: () => import('./bots/index'),
  diary: () => import('./diary/index'),
  family: () => import('./family/index'),
  legal: () => import('./legal/index'),
  multiserver: () => import('./multiserver/index'),
  totp: () => import('./totp/index'),
};
const manifests = [
  {
    "id": "office",
    "name": {
      "ru": "Документы",
      "en": "Documents"
    },
    "description": {
      "ru": "Групповые документы, таблицы и презентации: совместное редактирование в реальном времени, формулы, комментарии, история версий и экспорт",
      "en": "Group documents, spreadsheets and presentations: real-time co-editing, formulas, comments, version history and export"
    },
    "version": "1.0.1",
    "sdkVersion": 1,
    "deps": [],
    "backendApp": "sfera_office",
    "urlPrefix": "api/office/",
    "icon": "file-text",
    "provides": [
      "nav.rail",
      "main.view",
      "explore.card",
      "chat.composerAction",
      "app.overlay"
    ]
  },
  {
    "id": "whiteboard",
    "name": {
      "ru": "Доски",
      "en": "Whiteboards"
    },
    "description": {
      "ru": "Схемы и диаграммы как в draw.io: фигуры, связи, стикеры, рисование, совместная работа в реальном времени и экспорт",
      "en": "Diagrams like draw.io: shapes, connectors, sticky notes, drawing, real-time collaboration and export"
    },
    "version": "1.1.0",
    "sdkVersion": 1,
    "deps": [],
    "backendApp": "sfera_whiteboard",
    "urlPrefix": "api/whiteboard/",
    "icon": "pen-tool",
    "provides": [
      "nav.rail",
      "main.view",
      "explore.card"
    ]
  },
  {
    "id": "planner",
    "name": {
      "ru": "Планировщик задач",
      "en": "Task planner"
    },
    "description": {
      "ru": "Проекты с канбан-досками, списком и календарём: сроки, исполнители, чек-листы, повторы и напоминания",
      "en": "Projects with kanban boards, list and calendar: due dates, assignees, checklists, recurrence and reminders"
    },
    "version": "1.1.0",
    "sdkVersion": 1,
    "deps": [],
    "backendApp": "sfera_planner",
    "urlPrefix": "api/planner/",
    "icon": "calendar-check",
    "provides": [
      "nav.rail",
      "main.view",
      "explore.card",
      "app.overlay"
    ]
  },
  {
    "id": "conference",
    "name": {
      "ru": "Конференции",
      "en": "Conferences"
    },
    "description": {
      "ru": "Видеоконференции без ограничения участников: внутренние, приватные и внешние со входом гостей по ссылке",
      "en": "Video conferences with no participant cap: internal, private and external with guests joining by link"
    },
    "version": "1.1.0",
    "sdkVersion": 1,
    "deps": [],
    "backendApp": "sfera_conference",
    "urlPrefix": "api/conference/",
    "icon": "video",
    "preAuth": true,
    "provides": [
      "nav.rail",
      "main.view",
      "explore.card",
      "settings.page",
      "auth.route",
      "chat.composerAction"
    ]
  },
  {
    "id": "servers",
    "name": {
      "ru": "Серверы",
      "en": "Servers"
    },
    "description": {
      "ru": "Сообщества с текстовыми и голосовыми каналами, ролями и приглашениями",
      "en": "Communities with text and voice channels, roles and invites"
    },
    "version": "1.0.0",
    "sdkVersion": 1,
    "deps": [],
    "backendApp": "sfera_servers",
    "urlPrefix": "api/",
    "icon": "users",
    "provides": [
      "nav.rail",
      "main.view",
      "explore.search",
      "profile.section"
    ]
  },
  {
    "id": "channels",
    "name": {
      "ru": "Каналы",
      "en": "Channels"
    },
    "description": {
      "ru": "Личные каналы-ленты: публикуйте посты, подписывайтесь, комментируйте",
      "en": "Personal feed channels: publish posts, subscribe and comment"
    },
    "version": "1.0.0",
    "sdkVersion": 1,
    "deps": [],
    "backendApp": "sfera_channels",
    "urlPrefix": "api/channels/",
    "icon": "rss",
    "provides": [
      "nav.rail",
      "main.view",
      "explore.search"
    ]
  },
  {
    "id": "bots",
    "name": {
      "ru": "Боты",
      "en": "Bots"
    },
    "description": {
      "ru": "Сфероник, конструктор ботов и Bot API",
      "en": "Sferonik, bot studio and the Bot API"
    },
    "version": "1.0.0",
    "sdkVersion": 1,
    "deps": [],
    "backendApp": "sfera_bots",
    "urlPrefix": "api/bots/",
    "icon": "bot",
    "provides": [
      "explore.card",
      "chat.composerAction",
      "user.badge"
    ]
  },
  {
    "id": "diary",
    "name": {
      "ru": "Личные дневники",
      "en": "Personal diaries"
    },
    "description": {
      "ru": "Приватные записи, задачи, геометки и файлы — только для вас",
      "en": "Private notes, tasks, locations and files — just for you"
    },
    "version": "1.0.0",
    "sdkVersion": 1,
    "deps": [],
    "backendApp": "sfera_diary",
    "urlPrefix": "api/diary/",
    "icon": "notebook-pen",
    "provides": [
      "nav.rail",
      "main.view",
      "explore.card"
    ]
  },
  {
    "id": "family",
    "name": {
      "ru": "Семейный центр",
      "en": "Family centre"
    },
    "description": {
      "ru": "Детские аккаунты под присмотром родителей, одобрение друзей, геолокация семьи",
      "en": "Parent-managed child accounts, friend approvals and family locations"
    },
    "version": "1.0.0",
    "sdkVersion": 1,
    "deps": [],
    "backendApp": "sfera_family",
    "urlPrefix": "api/family/",
    "icon": "home",
    "provides": [
      "settings.page"
    ]
  },
  {
    "id": "legal",
    "name": {
      "ru": "Юридическая фиксация переписки",
      "en": "Legal evidence of conversations"
    },
    "description": {
      "ru": "Протокол переписки с хеш-цепочкой, подписи сторон и публичная проверка подлинности — чтобы переписку можно было предъявить в суд",
      "en": "A conversation protocol with a hash chain, signatures of the parties and public verification — so a chat can be shown in court"
    },
    "version": "1.0.0",
    "sdkVersion": 1,
    "deps": [],
    "backendApp": "sfera_legal",
    "urlPrefix": "api/legal/",
    "icon": "scale",
    "preAuth": true,
    "provides": [
      "nav.rail",
      "main.view",
      "explore.card",
      "settings.page",
      "chat.composerAction",
      "app.overlay",
      "auth.route"
    ]
  },
  {
    "id": "multiserver",
    "name": {
      "ru": "Несколько серверов",
      "en": "Multiple servers"
    },
    "description": {
      "ru": "Подключение к другим серверам Сферы: список серверов, пинг и свои TURN/STUN",
      "en": "Connect to other Sfera servers: server list, ping and custom TURN/STUN"
    },
    "version": "1.0.0",
    "sdkVersion": 1,
    "deps": [],
    "preAuth": true,
    "icon": "globe",
    "provides": [
      "auth.footer",
      "settings.page"
    ]
  },
  {
    "id": "totp",
    "name": {
      "ru": "Двухфакторная аутентификация",
      "en": "Two-factor authentication"
    },
    "description": {
      "ru": "Вход по коду из Google Authenticator и подобных приложений: резервные коды, обязательность для всех по решению администратора и блокировка приложения до подключения",
      "en": "Sign-in with a code from Google Authenticator and similar apps: backup codes, a server-wide requirement set by the superuser and a hard block until the authenticator is connected"
    },
    "version": "1.0.2",
    "sdkVersion": 2,
    "deps": [],
    "backendApp": "sfera_totp",
    "urlPrefix": "api/totp/",
    "icon": "shield-check",
    "provides": [
      "settings.page",
      "app.overlay"
    ]
  }
];
export const NATIVE_INFO: (ModuleInfo & { preAuth: boolean })[] = manifests.map(manifest => ({ ...manifest, deps: manifest.deps || [], preAuth: !!('preAuth' in manifest && manifest.preAuth), delivery: 'core-native', bundle: 'core-native:' + manifest.id, installed: false, deployed: true, active: false }));
