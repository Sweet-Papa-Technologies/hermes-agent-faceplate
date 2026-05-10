// Glue between the singular live `useConversationStore` (in-memory turn
// buffer) and the multi-conversation `useConversationsStore` (disk-backed
// list + active pointer).
//
// Lives only in the audio renderer (overlay / test mode). The conversation
// panel window doesn't run this — it's a viewer that subscribes to
// activeChanged + onChanged broadcasts for its own copy of the stores.
//
// Responsibilities:
//   1. Hydrate the singular store with the active conversation's persisted
//      turns at startup.
//   2. Persist a fresh snapshot on every finalize (Pinia $onAction).
//   3. React to activeChanged broadcasts (the user picked a different
//      conversation in the panel) by interrupting any in-flight turn,
//      clearing the buffer, and loading the new conversation's turns.

import { useConversationStore } from '../stores/conversation';
import { useConversationsStore } from '../stores/conversations';
import { interrupt as interruptTurn } from '../hermes/turn-handler';
import type { PersistedTurn } from '../stores/conversation-types';

const DEFAULT_TITLE = 'New conversation';

let detachActiveChanged: (() => void) | null = null;
let detachAction: (() => void) | null = null;
let attached = false;

export function attachConversationSyncer(): void {
  if (attached) return;
  attached = true;

  const convo = useConversationStore();
  const convs = useConversationsStore();

  // 1. Initial hydrate. faceplate-api boot has already loaded the active
  //    conversation, so by the time we run there's a list to draw from.
  if (convs.active) {
    convo.loadFromPersisted(convs.active.turns);
  }

  // 2. Persist on every finalize. Pinia $onAction fires after the action
  //    body runs; we snapshot the post-finalize state and push to disk.
  detachAction = convo.$onAction(({ name, after }) => {
    if (name !== 'finalizeTurn') return;
    after(() => {
      if (!convs.activeId) return;
      const turns = convo.snapshotForPersist();
      void convs.saveActive(turns, convs.activeSessionId);
      void maybeAutoTitle(turns);
    });
  });

  // 3. Cross-window switch. When the panel calls setActive() on a different
  //    conversation, main broadcasts to every window. In the audio
  //    renderer, the right response is: cancel anything running, then load
  //    the new turns + session id into the live buffer so the next user
  //    message picks up where the new conversation left off.
  const fp = window.faceplate;
  if (fp) {
    detachActiveChanged = fp.conversations.onActiveChanged((msg) => {
      interruptTurn('conversation.switch');
      if (msg.conversation) {
        convs.active = msg.conversation;
        convo.loadFromPersisted(msg.conversation.turns);
      } else {
        convs.active = null;
        convo.clear();
      }
    });
  }
}

/** Derive a friendly title from the first user message after the first
 * full exchange. Rule-based so we don't burn an extra LLM round-trip on
 * every fresh conversation. The user can override anytime via the title
 * input in the panel (doubleclick a list item to rename). */
async function maybeAutoTitle(turns: PersistedTurn[]): Promise<void> {
  const convs = useConversationsStore();
  if (!convs.active) return;
  if (convs.active.title !== DEFAULT_TITLE) return;
  const firstUser = turns.find((t) => t.role === 'user');
  const firstAsst = turns.find((t) => t.role === 'assistant');
  if (!firstUser || !firstAsst) return;
  const title = deriveTitle(firstUser.text);
  if (title === DEFAULT_TITLE) return;
  await convs.updateTitle(convs.active.id, title);
}

function deriveTitle(raw: string): string {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return DEFAULT_TITLE;
  // Strip a leading interjection so "hey, explain X" titles as "Explain X".
  const trimmed = cleaned.replace(/^(?:hey|hi|hello|ok|okay|so|um|hermes)[,.!\s]+/i, '');
  const head = trimmed || cleaned;
  if (head.length <= 56) return capitalizeFirst(head);
  const words = head.split(' ').slice(0, 7).join(' ');
  return capitalizeFirst(words) + '…';
}

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function detachConversationSyncer(): void {
  detachActiveChanged?.();
  detachAction?.();
  detachActiveChanged = null;
  detachAction = null;
  attached = false;
}
