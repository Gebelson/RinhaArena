# 💣 Blast Arena — Capivaras Combat 3D

Um jogo 3D de arena multiplayer e solo inspirado no BombSquad, rodando inteiramente no navegador via WebGL (Three.js) com física customizada e servidor WebSocket em Node.js com **zero dependências externas**.

---

## 🎮 Modos de Jogo

1. **🚩 Capture the Flag (CTF)**:
   - Duas equipes disputam duas bandeiras.
   - Roube a bandeira inimiga e traga para a sua base enquanto sua própria bandeira estiver segura.
   - Primeiro a 3 capturas vence a rodada.

2. **💀 Death Match**:
   - Batalha por equipes onde eliminações (frags) concedem pontos.
   - A equipe com mais eliminações ao atingir o limite ou fim do tempo vence.

3. **⚔️ Todos contra Todos (Free-For-All / FFA)**:
   - Sem equipes! Cada capivara por si.
   - Primeiro combatente a atingir 10 eliminações vence a partida.
   - Placar e líder de frags exibidos em tempo real no topo da tela.

---

## 🌐 Multiplayer & Salas Personalizadas

- **Navegador de Salas (Lobby)**:
  - Visualize todas as salas ativas criadas no servidor em tempo real.
  - Veja nome da sala, modo, mapa, número de jogadores, tempo de respawn e status de privacidade.
  - Escolha seu time de preferência (🔴 Vermelho, 🔵 Azul ou 🎲 Automático).

- **Criação de Partidas Personalizadas**:
  - **Pública ou Privada com Senha**: Proteja partidas com senha para jogar apenas com amigos.
  - **Tamanho de Equipes Assimétrico**: Escolha até 5 jogadores de cada lado, permitindo confrontos como 3 vs 1, 5 vs 2, 4 vs 4, etc.
  - **Modo FFA**: Configure até 10 combatentes individuais no todos contra todos.
  - **Tempo de Respawn**: Ajuste entre 1s, 2s, 3s, 5s e 8s.
  - **Seleção de Arenas**: Skyhaven, The Foundry, The Dojo ou Arena Procedural.
  - **Fogo Amigo (Friendly Fire)**: Ative ou desative o dano, socos e agarramentos entre aliados.

---

## 🕹️ Controles

| Ação | Teclado & Mouse (PC) | Touch (Mobile) |
|---|---|---|
| **Mover** | WASD / Setas direcionais | Joystick virtual esquerdo |
| **Bater / Socar** | **Botão Esquerdo do Mouse (LMB)** | Botão 👊 |
| **Arremessar Item Segurado** | **Botão Esquerdo do Mouse (LMB)** (quando segurando bomba/bandeira/jogador) | Botão 👊 |
| **Agarrar** | **Botão Direito do Mouse (RMB)** ou tecla **E** (para agarrar oponentes ou bandeira) | Botão ✋ |
| **Dash (Arrancada Rápida)** | **Shift** (com cooldown e efeito sonoro) | Botão ⚡ |
| **Pular** | **Espaço** | Botão ⬆️ |
| **Mirar** | Movimento do cursor do mouse | Direção do joystick |
| **Sair da Partida** | Tecla **Esc** ou botão de fechar | Botão ✕ no canto superior |

> 📦 **Bombas**: As bombas não surgem do nada! Colete as caixas amarelas de itens na arena para equipar bombas acesas nas mãos e lançá-las com o botão esquerdo.
> 🥊 **Luvas de Boxe (Insta-Nocaute)**: Coletar a caixa de luva concede socos de 100 de dano com nocaute instantâneo em um golpe só durante 20 segundos!

---

## 🗺️ Arenas Disponíveis

- **Skyhaven**: Plataformas flutuantes com pontes elevadas e abismos perigosos.
- **The Foundry**: Arena estilo fábrica com corredores laterais, barricadas centrais e chokepoints.
- **The Dojo**: Arena clássica de treinamento aberta com círculo central.
- **Arena Procedural**: Gera dinamicamente novos mapas com variações de biomas e geometrias toda vez que você clica em *🔄 Novo Layout*.

---

## 🚀 Como Executar

### Pré-requisitos
- Node.js instalado (v18 ou superior).

### Inicialização Rápida

```bash
# 1. Iniciar o servidor de jogo e multiplayer
npm start

# O jogo estará acessível em:
# http://localhost:8090
```

Para jogar em rede local (LAN) ou com amigos via internet, compartilhe o endereço IP da máquina ou utilize ferramentas como Tailscale/ngrok.

---

## 🧪 Testes e Validação

O projeto conta com uma suíte completa de testes automatizados:

```bash
# Executa a suíte de testes de combate, física, fogo amigo, assimétricos e FFA:
npm test

# Executa teste headless com bots e checagens de integridade da simulação:
npm run smoke
```

---

## 📁 Estrutura do Projeto

```
blast-arena/
├── index.html            # Ponto de entrada do jogo no navegador
├── styles.css            # Estilos da UI, menus, lobby e HUD
├── package.json          # Configurações do projeto e scripts
├── audio/                # Trilha sonora e efeitos de áudio (.mp3)
├── models/               # Modelos 3D (GLTF/GLB) das capivaras e cosméticos
├── server/
│   └── server.js         # Servidor HTTP e WebSocket com API de salas
├── src/
│   ├── main.js           # Orquestração do loop de renderização e estado
│   ├── core/             # Configurações gerais e matemática vetorial
│   ├── game/             # Simulação física, IA dos bots e modos de jogo (CTF, DM, FFA)
│   ├── net/              # Protocolo de rede e conexões (local e WebSocket)
│   ├── render/           # Renderização Three.js, partículas e modelos
│   └── ui/               # HUD, menus, lobby multiplayer e painel de testes
└── test_combat_redesign.js # Suíte de testes automatizados
```

---

## 🛡️ Licença
Distribuído sob licença aberta para uso pessoal e educacional.
