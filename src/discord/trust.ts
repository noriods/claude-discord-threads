/**
 * Trusting a reply's author, once.
 *
 * Replying to someone off the allowlist leaves their text out of the turn
 * (inbound.ts). This posts a Trust / No prompt in the thread and holds the
 * message until an allowlisted user taps one. Trust saves the author (a user
 * or a webhook such as our Alerts poster) to access.json's trustedAuthors and
 * sends the message on with the quote; No sends it on without. The button ids
 * carry the message ids, so a prompt still works after a restart.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  type Interaction,
  type Message,
  type TextBasedChannel,
} from 'discord.js'
import { loadAccess, noteSent, saveAccess } from './access'
import { fetchSendable } from './threads'
import { log, describeError } from '../log'

export async function askToTrust(client: Client, conversationId: string, ref: Message, msg: Message): Promise<void> {
  const id = `${msg.channelId}:${ref.id}:${msg.id}`
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`trust:yes:${id}`).setLabel('Trust').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`trust:no:${id}`).setLabel('No').setEmoji('❌').setStyle(ButtonStyle.Danger),
  )
  const ch = await fetchSendable(client, conversationId)
  const sent = await ch.send({
    content: `🔐 **${ref.author.username}** isn't trusted, so I can't see the message you replied to. Trust them for good?`,
    components: [row],
  })
  noteSent(sent.id)
}

export type TrustDeps = {
  isAllowedUser: (userId: string) => boolean
  /** Run the held message through the normal pipeline again. */
  resume: (msg: Message) => Promise<void>
}

export function attachTrustHandler(client: Client, deps: TrustDeps): void {
  client.on('interactionCreate', async (interaction: Interaction) => {
    if (!interaction.isButton()) return
    const m = /^trust:(yes|no):(\d+):(\d+):(\d+)$/.exec(interaction.customId)
    if (!m) return
    try {
      if (!deps.isAllowedUser(interaction.user.id)) {
        await interaction.reply({ content: 'Not authorized.', ephemeral: true })
        return
      }
      const prompt = interaction.message
      const source = (await fetchSendable(client, m[2]!)) as TextBasedChannel
      const held = await source.messages.fetch(m[4]!)
      if (m[1] === 'no') {
        await interaction.update({ content: `${prompt.content}\n\n❌ Not trusted`, components: [] })
        await deps.resume(held)
        return
      }
      const ref = await source.messages.fetch(m[3]!)
      const access = loadAccess()
      if (!access.trustedAuthors?.includes(ref.author.id)) {
        access.trustedAuthors = [...(access.trustedAuthors ?? []), ref.author.id]
        saveAccess(access)
      }
      await interaction.update({ content: `${prompt.content}\n\n✅ Trusted ${ref.author.username}`, components: [] })
      await deps.resume(held)
    } catch (err) {
      log.error('trust button failed', { id: interaction.customId, error: describeError(err) })
    }
  })
}
