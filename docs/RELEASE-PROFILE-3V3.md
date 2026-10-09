# Perfil, autenticação e Supabase Free

Esta entrega preserva o backend de partidas hospedadas pelo criador da sala.
Não instala as migrações de economia protegida/autoridade de 20261006 e 20261007.
As alterações modernas continuam no checkout principal para validação própria.

Aplicar somente as duas migrações compatíveis de 20261008 incluídas nesta entrega:
perfil/aparência/histórico privado e capacidade de salas de 1v1 a 3v3 (FFA até seis).
Elas preservam contas, saldos e inventários existentes. Salas antigas maiores
ficam indisponíveis até expirar; dados de jogadores não são apagados.

O histórico começa com novas partidas observadas pelo cliente. Não certifica
resultados ou recompensas. Falhas de envio permanecem numa fila por conta no
dispositivo e são reenviadas ao entrar ou abrir o próprio perfil.

Cadastro mantém confirmação inicial de e-mail. Conta confirmada entra com
e-mail e senha, sem novo envio. O tema das janelas de login/cadastro é o original.

O transporte mantém predição por frame e limita inputs/snapshots a 5 Hz.
Inputs e presença usam canais separados entre cada convidado e o host.
Uma sala com seis humanos tem orçamento recorrente estimado de 85 mensagens/s.
O limite Free é compartilhado pelo projeto: várias partidas simultâneas e
rajadas de reconexão/chat não são garantidas por este orçamento de uma sala.

Verificação: npm run test:profile, npm run test:compat-sql, npm run test:capacity,
npm run test:prediction, npm test, npm run test:matchmaking, npm run test:scoreboard,
npm run test:feira. Os testes locais não usam o Supabase real. O script explícito
scripts/test-free-room-cloud.mjs usa uma sala temporária somente se não houver
outra ativa, fecha os canais e encerra sua presença sem criar contas/resultados.

Antes da publicação, validar o SHA da implantação e o login no domínio real.
Para voltar à versão anterior, restaurar o deployment b2f70df2c4f1e2c64a2c8bf3f0d3ee96a1f14e4d.
O backend novo é aditivo; uma interface antiga deve usar 1v1 a 3v3.
