# Chat privado entre amigos

Abra **Amigos → Conversar**. A conversa possui histórico paginado, envio por Enter, quebra de linha com Shift + Enter, recibos de leitura e avisos de mensagens não lidas. Falhas de envio mantêm a mensagem na janela para tentar novamente com o mesmo identificador.

As mensagens ficam no Supabase e chegam por Postgres Changes com JWT e RLS. Apenas os dois participantes, enquanto forem amigos, podem ler a conversa. O remetente é determinado pela sessão; escritas diretas são proibidas. Limite de 1000 caracteres e 30 mensagens por minuto, com deduplicação dos reenvios. Nenhum conteúdo passa pelo broadcast público da partida. Quando o sistema de bloqueios estiver instalado, bloqueios em qualquer direção também impedem acesso e envio. Quedas de conexão têm reconexão automática com intervalo limitado a 30 segundos.

Migração independente: `supabase/migrations/20261009_private_friend_chat.sql`, compatível com a estrutura de amizades já publicada. Mantém o plano gratuito e o limite de partidas 3v3.

Verificação: `npm run test:chat`, testes existentes de perfil/login e SQL compatível; navegador com dois clientes locais, histórico, não lidas, recibos, falha/reenvio, texto seguro, integração Amigos e layout 844×390. Teste no banco hospedado usa identidades sintéticas em transação revertida. Não envia mensagens persistentes para contas reais; entrega entre duas contas autenticadas reais ainda requer teste dos jogadores.
