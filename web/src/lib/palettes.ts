/**
 * Amble's themes: a few palettes made by hand to be easy to look at, each named for how it feels.
 * Every color is a hue and a chroma (how much color, from 0, grey) in Material's HCT space; the
 * theme takes its light and dark tones from them. Accents stay soft, the surfaces carry only a
 * whisper of color, and each has a second, different hue (tertiary) for the small things that
 * should feel a little fun. `seed` is the nearest color the themes before these knew, so a device
 * still on an older version shows something close.
 */
export interface Palette {
  id: string;
  name: string;
  mood: string;
  seed: string;
  primary: readonly [number, number];
  secondary: readonly [number, number];
  tertiary: readonly [number, number];
  neutral: readonly [number, number];
  neutralVariant: readonly [number, number];
}

export const palettes: readonly Palette[] = [
  { id: 'grove', name: 'Grove', mood: 'Shade under trees, warm sand', seed: '#2e6a57', primary: [160, 22], secondary: [160, 10], tertiary: [75, 22], neutral: [150, 4], neutralVariant: [150, 6] },
  { id: 'sage', name: 'Sage', mood: 'Grey-green and linen', seed: '#5d7a63', primary: [135, 16], secondary: [120, 9], tertiary: [40, 18], neutral: [90, 4], neutralVariant: [100, 5] },
  { id: 'harbor', name: 'Harbor', mood: 'Misty blue and sea glass', seed: '#45658a', primary: [250, 18], secondary: [240, 10], tertiary: [185, 16], neutral: [240, 4], neutralVariant: [240, 6] },
  { id: 'dusk', name: 'Dusk', mood: 'Lavender evening, a little peach', seed: '#6e6293', primary: [295, 19], secondary: [290, 10], tertiary: [55, 22], neutral: [300, 4], neutralVariant: [300, 6] },
  { id: 'clay', name: 'Clay', mood: 'Terracotta and olive', seed: '#9a5c45', primary: [45, 26], secondary: [45, 12], tertiary: [110, 18], neutral: [65, 4], neutralVariant: [55, 7] },
  { id: 'tidepool', name: 'Tidepool', mood: 'Teal water, a coral stone', seed: '#2c7179', primary: [200, 20], secondary: [195, 10], tertiary: [30, 24], neutral: [195, 4], neutralVariant: [195, 6] },
  { id: 'chamomile', name: 'Chamomile', mood: 'Honey and cream', seed: '#8a6c2c', primary: [85, 22], secondary: [80, 12], tertiary: [145, 16], neutral: [85, 5], neutralVariant: [85, 7] },
  { id: 'fig', name: 'Fig', mood: 'Dried rose and moss', seed: '#8c5767', primary: [345, 17], secondary: [340, 10], tertiary: [120, 16], neutral: [340, 4], neutralVariant: [340, 6] },
  { id: 'slate', name: 'Slate', mood: 'Quiet grey, a touch of clay', seed: '#56616b', primary: [255, 10], secondary: [255, 6], tertiary: [45, 14], neutral: [255, 2], neutralVariant: [255, 4] },
];
