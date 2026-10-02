create or replace function public.create_profile_for_new_user()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.player_profiles(id,nickname)
  values(new.id,left(coalesce(nullif(trim(new.raw_user_meta_data->>'nickname'),''),split_part(new.email,'@',1),'Jogador'),12))
  on conflict(id) do nothing;
  return new;
end $$;

drop trigger if exists create_profile_after_signup on auth.users;
create trigger create_profile_after_signup
after insert on auth.users for each row execute function public.create_profile_for_new_user();
