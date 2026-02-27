import React from 'react';
import { useApp } from '../context/AppContext';

export const Settings: React.FC = () => {
  const { currentSettingsPage } = useApp();

  if (!currentSettingsPage) {
    return null;
  }

  return (
    <div className="settings-container">
      {currentSettingsPage === 'profile' && <ProfileSettings />}
      {currentSettingsPage === 'content' && <PrivacySettings />}
      {currentSettingsPage === 'data' && <DataSettings />}
      {currentSettingsPage === 'devices' && <DevicesSettings />}
      {currentSettingsPage === 'family' && <FamilySettings />}
      {currentSettingsPage === 'integration' && <IntegrationSettings />}
      {currentSettingsPage === 'notifications' && <NotificationSettings />}
      {currentSettingsPage === 'apps' && <AppsSettings />}
      {currentSettingsPage === 'nitro' && <NitroSettings />}
      {currentSettingsPage === 'subscribes' && <SubscribesSettings />}
      {currentSettingsPage === 'gifts' && <GiftsSettings />}
      {currentSettingsPage === 'payments' && <PaymentsSettings />}
      {currentSettingsPage === 'view' && <AppearanceSettings />}
      {currentSettingsPage === 'special' && <SpecialSettings />}
      {currentSettingsPage === 'voiceAndVideo' && <VoiceVideoSettings />}
      {currentSettingsPage === 'chat' && <ChatSettings />}
      {currentSettingsPage === 'binds' && <BindsSettings />}
      {currentSettingsPage === 'language' && <LanguageSettings />}
      {currentSettingsPage === 'exportImport' && <ExportImportSettings />}
      {currentSettingsPage === 'streamer' && <StreamerSettings />}
      {currentSettingsPage === 'more' && <MoreSettings />}
      {currentSettingsPage === 'privacyOfActivity' && <PrivacyActivitySettings />}
      {currentSettingsPage === 'games' && <GamesSettings />}
    </div>
  );
};

const ProfileSettings: React.FC = () => (
  <section>
    <h1>My Account</h1>
    <p>Manage your account settings and profile information</p>

    <div className="profile-preview-card">
      <div className="profile-banner-preview" style={{ backgroundImage: "url('https://images.pexels.com/photos/1366919/pexels-photo-1366919.jpeg?auto=compress&cs=tinysrgb&w=800')" }}></div>
      <div className="profile-avatar-wrapper">
        <img src="https://images.pexels.com/photos/220453/pexels-photo-220453.jpeg?auto=compress&cs=tinysrgb&w=100" alt="Avatar" className="profile-avatar-preview" />
      </div>
    </div>

    <form>
      <h3>Profile Information</h3>
      <label>Display Name
        <input type="text" name="displayname" defaultValue="Gemini User" placeholder="Enter your display name" />
      </label>

      <label>Username
        <input type="text" name="username" defaultValue="gemini_user" placeholder="Enter your username" />
      </label>

      <label>Email Address
        <input type="email" name="email" defaultValue="user@example.com" placeholder="Enter your email" />
      </label>

      <label>Phone Number
        <input type="text" name="phone" defaultValue="+1 (555) 123-4567" placeholder="Enter your phone number" />
      </label>

      <label>About Me
        <textarea name="bio" rows={3} placeholder="Tell us about yourself" style={{ width: '100%', padding: '12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '14px', resize: 'vertical', fontFamily: 'inherit' }} defaultValue="Digital explorer & creative thinker"></textarea>
      </label>

      <div className="settings-divider"></div>

      <h3>Account Security</h3>
      <div className="action-buttons-grid">
        <button type="button" className="glass-btn action-btn">Change Password</button>
        <button type="button" className="glass-btn action-btn">Enable 2FA</button>
        <button type="button" className="glass-btn action-btn">Security Keys</button>
        <button type="button" className="glass-btn action-btn">View Login History</button>
      </div>

      <div className="settings-divider"></div>

      <h3>Profile Customization</h3>
      <label className="ui-checkbox">
        <input type="checkbox" defaultChecked />
        <span className="ui-checkbox-box"></span>
        <span className="ui-checkbox-text">Show my profile to everyone</span>
      </label>
      <label className="ui-checkbox">
        <input type="checkbox" defaultChecked />
        <span className="ui-checkbox-box"></span>
        <span className="ui-checkbox-text">Display my online status</span>
      </label>
      <label className="ui-checkbox">
        <input type="checkbox" />
        <span className="ui-checkbox-box"></span>
        <span className="ui-checkbox-text">Show my activity status</span>
      </label>

      <div className="settings-divider"></div>

      <div className="form-footer">
        <button type="submit" className="save-btn">Save Changes</button>
        <button type="button" className="delete-account-btn">Delete Account</button>
      </div>
    </form>
  </section>
);

const PrivacySettings: React.FC = () => (
  <section>
    <h1>Privacy & Safety</h1>
    <p>Manage your content filtering and privacy preferences</p>

    <h3>Safe Direct Messaging</h3>
    <p>Filter direct messages from server members who are not friends</p>
    <label className="ui-checkbox">
      <input type="checkbox" defaultChecked />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">Keep me safe</span>
    </label>

    <div className="settings-divider"></div>

    <h3>Explicit Content Filter</h3>
    <p>Automatically scan and delete direct messages containing explicit media</p>

    <label className="ui-checkbox">
      <input type="checkbox" defaultChecked />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">Scan messages from everyone</span>
    </label>
    <label className="ui-checkbox">
      <input type="checkbox" />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">Scan messages from non-friends only</span>
    </label>
    <label className="ui-checkbox">
      <input type="checkbox" />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">Don't scan any messages</span>
    </label>

    <div className="settings-divider"></div>

    <h3>Blocked Users</h3>
    <p>You have blocked 3 users</p>
    <div className="blocked-users-list">
      {['Michael Jordan', 'Sarah Williams', 'Alex Thompson'].map((name, i) => (
        <div key={i} className="blocked-user-item">
          <div className="chat-avatar">
            <img src={`https://images.pexels.com/photos/${['1222271', '1239291', '415829'][i]}/pexels-photo-${['1222271', '1239291', '415829'][i]}.jpeg?auto=compress&cs=tinysrgb&w=100`} alt="User" />
          </div>
          <span>{name}</span>
          <button type="button" className="glass-btn">Unblock</button>
        </div>
      ))}
    </div>
  </section>
);

const NotificationSettings: React.FC = () => (
  <section>
    <h1>Notifications</h1>
    <p>Control how you receive notifications</p>

    <h3>Enable Desktop Notifications</h3>
    <label className="ui-checkbox">
      <input type="checkbox" defaultChecked />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">Enable all notifications</span>
    </label>

    <div className="settings-divider"></div>

    <h3>Push Notifications</h3>
    <label className="ui-checkbox">
      <input type="checkbox" defaultChecked />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">Direct messages</span>
    </label>
    <label className="ui-checkbox">
      <input type="checkbox" defaultChecked />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">Mentions</span>
    </label>
    <label className="ui-checkbox">
      <input type="checkbox" />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">All server messages</span>
    </label>
    <label className="ui-checkbox">
      <input type="checkbox" defaultChecked />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">Friend requests</span>
    </label>

    <div className="settings-divider"></div>

    <h3>Sounds</h3>
    <label className="ui-checkbox">
      <input type="checkbox" defaultChecked />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">Message notification sound</span>
    </label>
    <label className="ui-checkbox">
      <input type="checkbox" defaultChecked />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">Incoming call sound</span>
    </label>
  </section>
);

const AppearanceSettings: React.FC = () => (
  <section>
    <h1>Appearance</h1>
    <p>Customize how your app looks and feels</p>

    <form>
      <h3>Theme</h3>
      <label>App Theme
        <select name="theme">
          <option value="dark" selected>Dark</option>
          <option value="light">Light</option>
          <option value="system">Sync with system</option>
        </select>
      </label>

      <div className="settings-divider"></div>

      <h3>Message Display</h3>
      <label className="ui-checkbox">
        <input type="checkbox" defaultChecked />
        <span className="ui-checkbox-box"></span>
        <span className="ui-checkbox-text">Show message timestamps</span>
      </label>
      <label className="ui-checkbox">
        <input type="checkbox" defaultChecked />
        <span className="ui-checkbox-box"></span>
        <span className="ui-checkbox-text">Show avatars</span>
      </label>
    </form>
  </section>
);

const VoiceVideoSettings: React.FC = () => (
  <section>
    <h1>Voice & Video</h1>
    <p>Configure your audio and video settings</p>

    <form>
      <h3>Input Device</h3>
      <label>Microphone
        <select name="microphone">
          <option value="default">Default</option>
          <option value="usb-pnp" selected>USB PNP Microphone</option>
          <option value="built-in">Built-in Microphone</option>
        </select>
      </label>

      <label className="ui-checkbox">
        <input type="checkbox" defaultChecked />
        <span className="ui-checkbox-box"></span>
        <span className="ui-checkbox-text">Automatically determine input sensitivity</span>
      </label>

      <div className="settings-divider"></div>

      <h3>Voice Processing</h3>
      <label className="ui-checkbox">
        <input type="checkbox" defaultChecked />
        <span className="ui-checkbox-box"></span>
        <span className="ui-checkbox-text">Echo cancellation</span>
      </label>
      <label className="ui-checkbox">
        <input type="checkbox" defaultChecked />
        <span className="ui-checkbox-box"></span>
        <span className="ui-checkbox-text">Noise suppression</span>
      </label>
    </form>
  </section>
);

const LanguageSettings: React.FC = () => (
  <section>
    <h1>Language</h1>
    <p>Choose your preferred language</p>

    <form>
      <h3>Select Language</h3>
      <label>
        <select name="language">
          <option value="en">English</option>
          <option value="ru">Русский</option>
        </select>
      </label>
    </form>
  </section>
);

const DataSettings: React.FC = () => (
  <section>
    <h1>Data and Privacy</h1>
    <form>
      <label className="ui-checkbox">
        <input type="checkbox" defaultChecked />
        <span className="ui-checkbox-box"></span>
        <span className="ui-checkbox-text">Use my data for app improvements</span>
      </label>
      <label className="ui-checkbox">
        <input type="checkbox" defaultChecked />
        <span className="ui-checkbox-box"></span>
        <span className="ui-checkbox-text">Use my data for personalization</span>
      </label>
      <div className="settings-divider"></div>
      <button type="button" className="glass-btn action-btn">Download my data</button>
    </form>
  </section>
);

const DevicesSettings: React.FC = () => (
  <section>
    <h1>Devices</h1>
    <h3>Computers</h3>
    <div style={{ marginTop: '16px' }}>
      <div className="device-item">
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: '24px', height: '24px' }}>
          <path d="M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/>
        </svg>
        <span>Alan desktop</span>
      </div>
      <div className="device-item">
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: '24px', height: '24px' }}>
          <path d="M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/>
        </svg>
        <span>Alan notebook</span>
      </div>
    </div>
  </section>
);

const FamilySettings: React.FC = () => (
  <section>
    <h1>Family Center</h1>
    <p>Set up parental controls and monitor family activity.</p>
    <button type="button" className="glass-btn action-btn">Set up Family Center</button>
  </section>
);

const IntegrationSettings: React.FC = () => (
  <section>
    <h1>Integrations</h1>
    <h3>Connected Services</h3>
    <div style={{ marginTop: '16px' }}>
      {['GitHub', 'Steam', 'Reddit'].map((service) => (
        <div key={service} className="integration-item">
          <span>{service}</span>
          <button type="button" className="glass-btn">Disconnect</button>
        </div>
      ))}
    </div>
    <div className="settings-divider"></div>
    <button type="button" className="glass-btn action-btn">Add Integration</button>
  </section>
);

const AppsSettings: React.FC = () => (
  <section>
    <h1>Connected Apps</h1>
    <div style={{ marginTop: '16px' }}>
      {['Max', 'Gosuslugi'].map((app) => (
        <div key={app} className="app-item">
          <span>{app}</span>
          <button type="button" className="glass-btn">Revoke Access</button>
        </div>
      ))}
    </div>
  </section>
);

const NitroSettings: React.FC = () => (
  <section>
    <h1>Nitro Subscription</h1>
    <div className="nitro-card">
      <h3>Nitro Active</h3>
      <p>Enjoy premium features and perks</p>
      <button type="button" className="glass-btn action-btn">Manage Subscription</button>
    </div>
  </section>
);

const SubscribesSettings: React.FC = () => (
  <section>
    <h1>Server Subscriptions</h1>
    <h3>Active Subscriptions</h3>
    <div style={{ marginTop: '16px' }}>
      {['EFT', 'Factorio'].map((sub) => (
        <div key={sub} className="subscription-item">
          <span>{sub}</span>
          <button type="button" className="glass-btn">Manage</button>
        </div>
      ))}
    </div>
  </section>
);

const GiftsSettings: React.FC = () => (
  <section>
    <h1>Gifts Inventory</h1>
    <div className="gifts-grid">
      {['Gold ingot', 'Rocket', 'Christmas Tree'].map((gift) => (
        <div key={gift} className="gift-item">{gift}</div>
      ))}
    </div>
  </section>
);

const PaymentsSettings: React.FC = () => (
  <section>
    <h1>Payment Settings</h1>
    <h3>Current Month Bill: $350</h3>
    <div className="settings-divider"></div>
    <h3>Saved Payment Methods</h3>
    <div style={{ marginTop: '16px' }}>
      {['**** **** **** 4444', '**** **** **** 6877'].map((card, i) => (
        <div key={i} className="payment-item">
          <span>{card}</span>
          <button type="button" className="glass-btn">Remove</button>
        </div>
      ))}
    </div>
    <button type="button" className="glass-btn action-btn" style={{ marginTop: '20px' }}>Add Payment Method</button>
  </section>
);

const SpecialSettings: React.FC = () => (
  <section>
    <h1>Accessibility</h1>
    <p>Configure accessibility features for better usability.</p>
    <label className="ui-checkbox">
      <input type="checkbox" />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">High contrast mode</span>
    </label>
    <label className="ui-checkbox">
      <input type="checkbox" />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">Screen reader support</span>
    </label>
  </section>
);

const ChatSettings: React.FC = () => (
  <section>
    <h1>Chat Settings</h1>
    <label className="ui-checkbox">
      <input type="checkbox" defaultChecked />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">Show timestamps</span>
    </label>
    <label className="ui-checkbox">
      <input type="checkbox" defaultChecked />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">Enable emoji reactions</span>
    </label>
    <label className="ui-checkbox">
      <input type="checkbox" />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">Compact mode</span>
    </label>
  </section>
);

const BindsSettings: React.FC = () => (
  <section>
    <h1>Keybindings</h1>
    <div className="keybind-list">
      <div className="keybind-item">
        <span>Mute/Unmute</span>
        <kbd>Ctrl + Shift + M</kbd>
      </div>
      <div className="keybind-item">
        <span>Deafen/Undeafen</span>
        <kbd>Ctrl + Shift + D</kbd>
      </div>
      <div className="keybind-item">
        <span>Push to Talk</span>
        <kbd>Ctrl + Space</kbd>
      </div>
    </div>
    <button type="button" className="glass-btn action-btn">Add Keybind</button>
  </section>
);

const ExportImportSettings: React.FC = () => (
  <section>
    <h1>Export & Import</h1>
    <p>Backup and restore your settings</p>
    <form>
      <h3>Export Settings</h3>
      <p>Download all your settings as a JSON file</p>
      <button type="button" className="glass-btn action-btn">Export Settings</button>
      <div className="settings-divider"></div>
      <h3>Import Settings</h3>
      <p>Upload a previously exported settings file</p>
      <button type="button" className="glass-btn action-btn">Import Settings</button>
    </form>
  </section>
);

const StreamerSettings: React.FC = () => (
  <section>
    <h1>Streamer Mode</h1>
    <label className="ui-checkbox">
      <input type="checkbox" />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">Enable streamer mode</span>
    </label>
    <div className="settings-divider"></div>
    <h3>Privacy Options</h3>
    <label className="ui-checkbox">
      <input type="checkbox" />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">Hide personal information</span>
    </label>
    <label className="ui-checkbox">
      <input type="checkbox" />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">Disable notifications</span>
    </label>
  </section>
);

const MoreSettings: React.FC = () => (
  <section>
    <h1>Advanced Settings</h1>
    <label className="ui-checkbox">
      <input type="checkbox" />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">Developer mode</span>
    </label>
    <label className="ui-checkbox">
      <input type="checkbox" />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">Hardware acceleration</span>
    </label>
    <button type="button" className="glass-btn action-btn">Clear cache</button>
  </section>
);

const PrivacyActivitySettings: React.FC = () => (
  <section>
    <h1>Activity Privacy</h1>
    <label className="ui-checkbox">
      <input type="checkbox" defaultChecked />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">Show current activity</span>
    </label>
    <label className="ui-checkbox">
      <input type="checkbox" defaultChecked />
      <span className="ui-checkbox-box"></span>
      <span className="ui-checkbox-text">Show game status</span>
    </label>
  </section>
);

const GamesSettings: React.FC = () => (
  <section>
    <h1>Registered Games</h1>
    <div className="games-list">
      {['Escape from Tarkov', 'Minecraft', 'Factorio', 'Cyberpunk 2077'].map((game) => (
        <div key={game} className="game-item">{game}</div>
      ))}
    </div>
    <button type="button" className="glass-btn action-btn">Add Game</button>
  </section>
);
