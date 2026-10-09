import { SUPABASE_URL } from '../net/supabase.js';

export const AVATARS = Array.from({ length: 10 }, (_, index) => `avatar-${index + 1}.webp`);
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const uploaded = new RegExp(`^uploaded:(${uuid})/(${uuid})[.]webp$`, 'i');
export const isAvatarId = value => AVATARS.includes(value) || uploaded.test(String(value));
export function getAvatarUrl(value) {
  const match = uploaded.exec(String(value));
  return match ? `${SUPABASE_URL}/storage/v1/object/public/profile-avatars/${match[1]}/${match[2]}.webp`
    : `./assets/ui/avatars/${AVATARS.includes(value) ? value : AVATARS[0]}`;
}
