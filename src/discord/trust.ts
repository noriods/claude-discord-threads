/**
 * Trusting a reply's author, once.
 *
 * Replying to someone off the allowlist leaves their text out of the turn
 * (inbound.ts). This posts a Trust / No prompt in the thread; when an
 * allowlisted user taps Trust, the author (a user or a webhook such as our
 * Alerts poster) is saved to access.json's trustedAuthors, and the text that
 * was left out is sent on as a follow-up turn. From then on replies to that
 * author are quoted straight away.
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
import { quoteMessage } from './inbound'
import { fetchSendable } from './threads'
import { log, describeError } from '../log'

export async function askToTrust(client: Client, conversationId: string, ref: Message): Promise<void> {
  const id = `${ref.channelId}:${ref.id}`
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
  enqueueTurn: (conversationId: string, content: string, userId: string) => Promise<boolean>
}

export function attachTrustHandler(client: Client, deps: TrustDeps): void {
  client.on('interactionCreate', async (interaction: Interaction) => {
    if (!interaction.isButton()) return
    const m = /^trust:(yes|no):(\d+):(\d+)$/.exec(interaction.customId)
    if (!m) return
    try {
      if (!deps.isAllowedUser(interaction.user.id)) {
        await interaction.reply({ content: 'Not authorized.', ephemeral: true })
        return
      }
      const prompt = interaction.message
      if (m[1] === 'no') {
        await interaction.update({ content: `${prompt.content}\n\n❌ Not trusted`, components: [] })
        return
      }
      const source = (await fetchSendable(client, m[2]!)) as TextBasedChannel
      const ref = await source.messages.fetch(m[3]!)
      const access = loadAccess()
      if (!access.trustedAuthors?.includes(ref.author.id)) {
        access.trustedAuthors = [...(access.trustedAuthors ?? []), ref.author.id]
        saveAccess(access)
      }
      await interaction.update({ content: `${prompt.content}\n\n✅ Trusted ${ref.author.username}`, components: [] })
      await deps.enqueueTurn(interaction.channelId, `${quoteMessage(ref)}(This is the message my last reply was about.)`, interaction.user.id)
    } catch (err) {
      log.error('trust button failed', { id: interaction.customId, error: describeError(err) })
    }
  })
}
