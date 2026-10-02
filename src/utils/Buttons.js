import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

// Text labels: bot buttons carry no emoji
const ROW_ONE = [
    { id: 'LOW_VOL_BUT', label: 'Vol -' },
    { id: 'PREV_BUT', label: 'Previous' },
    { id: 'PAUSE_BUT', label: 'Pause' },
    { id: 'SKIP_BUT', label: 'Skip' },
    { id: 'HIGH_VOL_BUT', label: 'Vol +' }
];

const ROW_TWO = [
    { id: 'REWIND_BUT', label: 'Rewind' },
    { id: 'LOOP_BUT', label: 'Loop' },
    { id: 'STOP_BUT', label: 'Stop' },
    { id: 'SHUFFLE_BUT', label: 'Shuffle' },
    { id: 'FORWARD_BUT', label: 'Forward' }
];

function buildRow(buttons) {
    return new ActionRowBuilder().addComponents(
        buttons.map(({ id, label }) => new ButtonBuilder()
            .setCustomId(id)
            .setLabel(label)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(false))
    );
}

// Fresh builders on every call: callers toggle setDisabled() on the returned rows
const getButtons = () => [buildRow(ROW_ONE), buildRow(ROW_TWO)];

export { getButtons };
export default getButtons;
