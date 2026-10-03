export const EMOTE_PRICE = 500;

export const EMOTES = [
  { id: 'capivara-joinha', name: 'Capivara Joinha' },
  { id: 'crocodilo-luta', name: 'Crocodilo na Luta' },
  { id: 'pato-festa', name: 'Pato em Festa' },
  { id: 'gato-estilo', name: 'Gato Estiloso' },
  { id: 'porco-festa', name: 'Porco em Festa' },
  { id: 'macaco-joinha', name: 'Macaco Joinha' },
  { id: 'cachorro-joinha', name: 'Cachorro Joinha' },
  { id: 'tubarao-luta', name: 'Tubarão na Luta' },
].map((emote) => ({ ...emote, image: `./assets/ui/emotes/${emote.id}.webp` }));

export const EMOTE_IDS = new Set(EMOTES.map((emote) => emote.id));
export const getEmote = (id) => EMOTES.find((emote) => emote.id === id) || null;
