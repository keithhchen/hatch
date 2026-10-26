import React, { useEffect, useReducer } from "react";
import { Avatar, CommandMenu } from "@hatch/ui";
import { MessageSquare } from "lucide-react";
import { useObservable } from "../observable.js";
import { useDesktop } from "./context.js";

/** Re-render when any Agent's library changes while the palette is open. */
function useLibraries(app, agents) {
  const [, bump] = useReducer(count => count + 1, 0);
  useEffect(() => {
    const stops = agents.map(agent => app.library(agent).subscribe(bump));
    return () => { for (const stop of stops) stop(); };
  }, [app, agents]);
}

/** ⌘K: jump to any Agent or any loaded conversation. */
export function SearchPalette() {
  const { app, t } = useDesktop();
  const ui = useObservable(app);
  const { agents } = useObservable(app.session);
  useLibraries(app, agents);
  const groups = [
    {
      label: t("search.conversations"),
      items: agents.flatMap(agent => app.library(agent).getState().conversations.map(conversation => ({
        value: `${agent.key}:${conversation.id}`,
        label: conversation.title || t("conversation.untitled"),
        keywords: agent.name,
        icon: <MessageSquare aria-hidden="true" />,
        onSelect: () => void app.select(agent, conversation.id)
      })))
    },
    {
      label: t("search.agents"),
      items: agents.map(agent => ({
        value: agent.key,
        label: agent.name,
        keywords: agent.creatorName,
        icon: <Avatar className="desk-row__avatar" src={agent.identity.creatorAvatarUrl} name={agent.creatorName} size="small" />,
        onSelect: () => void app.selectAgent(agent)
      }))
    }
  ].filter(group => group.items.length);
  return <CommandMenu open={ui.overlay === "search"} onOpenChange={open => { if (!open) app.closeOverlay(); }}
    groups={groups} placeholder={t("search.placeholder")} empty={t("search.empty")} title={t("search.title")} />;
}
