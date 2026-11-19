/** Guild operations borrow the unlocked device coordinator and archive. */
import { DmCipherQueuedError } from './cipherQueuedError';
import type { DmCipherCoordinator } from './dmCipherCoordinator';
import type { DmCipherOutbox } from './dmCipherOutbox';
import type { CipherArchive } from './cipherArchive';
import { parseGuildCipherMessage, type GuildCipherMessage } from './guildCipherMessage';
import type { DmCipherText } from './dmCipherMessage';
import { accountBytes, accountDigest } from './account';

export class GuildCipherSession {
  readonly outbox: DmCipherOutbox<GuildCipherMessage>;
  private coordinator: DmCipherCoordinator;
  private archive: CipherArchive;
  constructor(coordinator: DmCipherCoordinator, outbox: DmCipherOutbox<GuildCipherMessage>, archive: CipherArchive) {
    this.coordinator = coordinator; this.outbox = outbox; this.archive = archive;
  }
  prepare(scope: string) { return this.coordinator.publishGuildKeys(scope); }
  async send(guild: string, scope: string, payload: DmCipherText) {
    const intent = await this.outbox.create(scope, payload, guild);
    try {
      await this.prepare(scope);
      const sent = await this.outbox.send(intent.id); await this.archiveAccepted(sent.id); return sent;
    } catch (error) { throw new DmCipherQueuedError(intent.id, error); }
  }
  async retry(id: string) {
    const record = (await this.outbox.list()).find(row => row.id === id);
    if (!record) throw new Error('guild_outbox_message_missing');
    if (record.state === 'draft') await this.prepare(record.scope);
    const sent = await this.outbox.send(id); await this.archiveAccepted(id); return sent;
  }
  async receive(scope: string) { await this.prepare(scope); return this.coordinator.receiveGuildKeys(scope); }
  private async erase(scope: string, id: string, digest: string) {
    await this.archive.removeLocal('guild', scope, id);
    await this.outbox.rejectDeleted(id, digest); await this.outbox.forget(id);
  }
  async archiveAccepted(id: string) {
    const record = (await this.outbox.list()).find(row => row.id === id);
    if (!record || record.state !== 'accepted' || !record.wire || !record.guild) return;
    const checked = await this.coordinator.guildMessageStatus(record.guild, record.scope, [record.wire]);
    const [status] = checked.messages;
    if (status.state === 'deleted') { await this.erase(record.scope, id, status.digest); return; }
    if (status.state !== 'present') throw new Error('cipher_archive_current_status_unavailable');
    const cached = await this.archive.read('guild', record.scope, id);
    const saved = cached ? await this.coordinator.openGuildArchived(record.guild, record.scope, record.wire, this.archive)
      : await this.coordinator.archiveGuildOutgoing(record.guild, record.scope, record.wire, record.payload, this.archive, record.authorization);
    if (saved.text !== record.payload.text || saved.replyTo !== record.payload.replyTo) throw new Error('cipher_archive_message_fork');
    if (checked.expiresAt <= Date.now() / 1000) throw new Error('guild_cipher_status_expired');
    await this.outbox.forget(id);
  }
  async openMessages(guild: string, scope: string, values: unknown[]) {
    const wires = values.map(value => parseGuildCipherMessage(value, guild, scope));
    const checked = await this.coordinator.guildMessageStatus(guild, scope, wires);
    const result: Array<{ id: string; text: string | null; sender: { user: string }; deleted: boolean; unavailable?: boolean }> = [];
    for (let i = 0; i < wires.length; i++) {
      const wire = wires[i], status = checked.messages[i];
      if (checked.expiresAt <= Date.now() / 1000) throw new Error('guild_cipher_status_expired');
      if (status.state === 'deleted') {
        await this.erase(scope, wire.id, status.digest);
        result.push({ id: wire.id, text: null, sender: wire.sender, deleted: true }); continue;
      }
      if (status.state !== 'present') throw new Error('cipher_archive_current_status_unavailable');
      const local = (await this.outbox.list()).find(row => row.id === wire.id && row.wire);
      if (local) {
        if (local.guild !== guild || local.scope !== scope || await accountDigest(accountBytes(local.wire)) !== status.digest) throw new Error('cipher_archive_message_fork');
        if (local.state === 'accepted') await this.archiveAccepted(local.id);
        else if (!await this.archive.read('guild', scope, wire.id)) await this.coordinator.archiveGuildOutgoing(guild, scope, wire, local.payload, this.archive, local.authorization);
      }
      const own = this.coordinator.publicIdentity();
      if (status.authorization && !status.authorization.body.certificates.some(certificate => certificate.body.owner === own.owner && certificate.body.device === own.device) &&
          !await this.archive.read('guild', scope, wire.id)) {
        result.push({ id: wire.id, text: null, sender: wire.sender, deleted: false, unavailable: true }); continue;
      }
      try {
        const opened = await this.coordinator.openGuildArchived(guild, scope, wire, this.archive, status.authorization ?? undefined);
        result.push({ ...opened, deleted: false });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'cipher_historical_key_unavailable') throw error;
        result.push({ id: wire.id, text: null, sender: wire.sender, deleted: false, unavailable: true });
      }
    }
    if (checked.expiresAt <= Date.now() / 1000) throw new Error('guild_cipher_status_expired');
    return result;
  }
  async drain(guild: string, scope: string, limit = 8) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16) throw new Error('invalid_guild_drain_limit');
    const records = (await this.outbox.list()).filter(row => row.guild === guild && row.scope === scope && row.state === 'accepted').slice(0, limit);
    for (const record of records) await this.archiveAccepted(record.id);
  }
}
