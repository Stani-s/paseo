import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { SPEECH_TTS_SYNTHESIZE_MAX_TEXT_CHARS } from "@getpaseo/protocol/speech/rpc-schemas";
import { Volume2 } from "lucide-react-native";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  useContextMenu,
} from "@/components/ui/context-menu";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useReadAloud } from "@/contexts/read-aloud-context";
import { useToastOptional } from "@/contexts/toast-api-context";
import { useSessionStore } from "@/stores/session-store";
import { getVoiceReadinessState } from "@/utils/server-info-capabilities";

interface WebContextMenuEvent {
  nativeEvent: { pageX: number; pageY: number };
  target: unknown;
  preventDefault(): void;
  stopPropagation(): void;
}

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedVolumeIcon = withUnistyles(Volume2);

/**
 * Right-click a text selection in the agent stream to synthesize it. The menu opens only
 * when the click lands over selected text inside the stream, so the browser's own menu
 * stays available everywhere else. Native platforms keep their system selection menu.
 */
export function ReadAloudSelectionMenu({
  serverId,
  children,
}: {
  serverId: string | null;
  children: ReactNode;
}) {
  const client = useSessionStore(
    useCallback(
      (state) => (serverId ? (state.sessions[serverId]?.client ?? null) : null),
      [serverId],
    ),
  );
  const isSupported = useSessionStore(
    useCallback(
      (state) =>
        getVoiceReadinessState({
          serverInfo: serverId ? (state.sessions[serverId]?.serverInfo ?? null) : null,
          mode: "readAloud",
        })?.enabled === true,
      [serverId],
    ),
  );

  if (!isSupported || !client) {
    return children;
  }

  return <SelectionMenuSurface client={client}>{children}</SelectionMenuSurface>;
}

function SelectionMenuSurface({ client, children }: { client: DaemonClient; children: ReactNode }) {
  const { t } = useTranslation();
  const toast = useToastOptional();
  const contextMenu = useContextMenu();
  const containerRef = useRef<View | null>(null);
  const readAloud = useReadAloud();
  const selectionRef = useRef<string>("");
  const leadingIcon = useMemo(
    () => <ThemedVolumeIcon size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />,
    [],
  );

  const handleContextMenu = useCallback(
    (event: WebContextMenuEvent) => {
      const selection = window.getSelection();
      const containerNode = containerRef.current as unknown as Node | null;
      const selectedText =
        selection && containerNode?.contains(selection.anchorNode)
          ? selection.toString().trim()
          : "";
      if (!selectedText) {
        return;
      }
      selectionRef.current = selectedText;
      event.preventDefault();
      event.stopPropagation();
      contextMenu.setAnchorRect({
        x: event.nativeEvent.pageX,
        y: event.nativeEvent.pageY,
        width: 0,
        height: 0,
      });
      contextMenu.setOpen(true);
    },
    [contextMenu],
  );

  const handleSpeak = useCallback(() => {
    const text = selectionRef.current.slice(0, SPEECH_TTS_SYNTHESIZE_MAX_TEXT_CHARS).trim();
    if (!text) return;
    const utteranceId = `selection:${text.slice(0, 64)}:${text.length}`;
    void readAloud.speak({ utteranceId, client, text }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      toast?.error(`${t("message.actions.readAloudError")}: ${message}`);
    });
  }, [client, readAloud, t, toast]);

  return (
    <ContextMenu>
      <View
        {...({ onContextMenu: handleContextMenu } as Record<string, unknown>)}
        ref={containerRef}
      >
        {children}
      </View>
      <ContextMenuContent testID="read-aloud-selection-menu">
        <ContextMenuItem
          leading={leadingIcon}
          onSelect={handleSpeak}
          testID="read-aloud-selection-speak-item"
        >
          {t("message.actions.speakSelection")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
