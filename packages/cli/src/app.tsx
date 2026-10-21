import { useKeyboard } from "@opentui/react";
import { Header } from "./components/header";
import { InputBar } from "./components/input-bar";
import { Transcript } from "./components/transcript";
import { ToastProvider } from "./providers/toast";
import { KeyboardLayerProvider, useKeyboardLayer } from "./providers/keyboard-layer";
import { DialogProvider } from "./providers/dialog";
import { ThemeProvider, useTheme } from "./providers/theme";
import { SessionProvider, useSession } from "./providers/session";

function Approval() {
  const { approval } = useSession();
  const { colors } = useTheme();
  useKeyboard((k) => {
    if (!approval) return;
    if (k.name === "y") approval.resolve(true);
    if (k.name === "n" || k.name === "escape") approval.resolve(false);
  });
  if (!approval) return null;
  return (
    <box width="100%" maxWidth={78} paddingX={2} backgroundColor={colors.surface} flexDirection="row" gap={1}>
      <text fg={colors.planMode}>allow {approval.what}?</text>
      <text fg={colors.dimSeparator}>y / n</text>
    </box>
  );
}

function Screen() {
  const { colors } = useTheme();
  const { entries, running, stop, approval } = useSession();
  const { isTopLayer } = useKeyboardLayer();
  useKeyboard((k) => { if (k.name === "escape" && running && !approval && isTopLayer("base")) stop(); });
  const started = entries.length > 0;
  return (
    <box backgroundColor={colors.background} width="100%" height="100%" flexDirection="column" alignItems="center" justifyContent={started ? "flex-end" : "center"} gap={started ? 0 : 2}>
      {!started && <Header />}
      {started && <Transcript />}
      <Approval />
      <box width="100%" maxWidth={78} paddingX={2}>
        <InputBar onSubmit={(t) => send(t)} disabled={running && !!approval} />
      </box>
    </box>
  );
  function send(t: string) { sessionSend(t); }
}

let sessionSend: (t: string) => void = () => {};
function Bridge() {
  const s = useSession();
  sessionSend = s.send;
  return <Screen />;
}

export function App() {
  return (
    <ThemeProvider>
      <SessionProvider>
        <KeyboardLayerProvider>
          <DialogProvider>
            <ToastProvider>
              <Bridge />
            </ToastProvider>
          </DialogProvider>
        </KeyboardLayerProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}
