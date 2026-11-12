/**
 * Buttons that run a local command.
 *
 * A bot message with custom_id `cmd:<name>:<arg>` runs the command registered
 * under <name> in ~/.claude/channels/discord/buttons.json ({"name": [argv...]})
 * with <arg> appended. Only registered names run, and only for allowlisted
 * users. On success the command's output replaces the buttons, so a second tap
 * is impossible; on failure the buttons stay and the error is shown privately.
 * A registry entry {"argv": [...], "modal": "Label"} first asks for one
 * paragraph of text and appends it after <arg>. Exit code 3 = a plain private
 * answer (e.g. "needs your call"), buttons stay.
 */

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Client,
  type Interaction,
} from 'discord.js'
import { log, describeError } from '../log'

const run = promisify(execFile)
const REGISTRY = join(homedir(), '.claude', 'channels', 'discord', 'buttons.json')

export function attachCommandButtons(client: Client, isAllowedUser: (id: string) => boolean): void {
  client.on('interactionCreate', async (interaction: Interaction) => {
    if (!interaction.isButton() && !interaction.isModalSubmit()) return
    const m = /^cmd:([\w-]+):([\w.-]+)$/.exec(interaction.customId)
    if (!m) return
    try {
      if (!isAllowedUser(interaction.user.id)) {
        await interaction.reply({ content: 'Not allowed.', ephemeral: true })
        return
      }
      const entry = JSON.parse(readFileSync(REGISTRY, 'utf8'))[m[1]!]
      const argv: string[] | undefined = Array.isArray(entry) ? entry : entry?.argv
      if (!argv) {
        await interaction.reply({ content: `No command registered as ${m[1]}.`, ephemeral: true })
        return
      }
      const extra: string[] = []
      if (entry.modal && interaction.isButton()) {
        await interaction.showModal(
          new ModalBuilder()
            .setCustomId(interaction.customId)
            .setTitle(entry.modal.slice(0, 45))
            .addComponents(
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                  .setCustomId('text')
                  .setLabel(entry.modal.slice(0, 45))
                  .setStyle(TextInputStyle.Paragraph)
                  .setRequired(true),
              ),
            ),
        )
        return
      }
      if (interaction.isModalSubmit()) extra.push(interaction.fields.getTextInputValue('text').trim())
      await interaction.deferReply({ ephemeral: true })
      try {
        const { stdout } = await run(argv[0]!, [...argv.slice(1), m[2]!, ...extra], { timeout: 600_000 })
        const msg = interaction.message
        if (msg) await msg.edit({ content: `${msg.content}\n\n${stdout.trim()}`.slice(0, 2000), components: [] })
        await interaction.editReply(stdout.trim().slice(0, 1900) || 'Done.')
      } catch (err: any) {
        const why = (err?.stderr || err?.message || String(err)).trim()
        await interaction.editReply(err?.code === 3 ? why.slice(-1900) : `Failed:\n${why.slice(-1800)}`)
      }
    } catch (err) {
      log.error('command button failed', { id: interaction.customId, error: describeError(err) })
    }
  })
}
