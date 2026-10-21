import { ThemeDialogContent, ModelsDialogContent, HarnessDialogContent, ProvidersDialogContent, PolicyDialogContent, SessionsDialogContent } from "../dialogs";
import type { Command } from "./types";

export const COMMANDS: Command[] = [
  { name: "new", description: "Start a new conversation", value: "/new", action: (ctx) => { ctx.newChat(); ctx.toast.show({ message: "New conversation" }); } },
  { name: "sessions", description: "Resume a past conversation", value: "/sessions", action: (ctx) => ctx.dialog.open({ title: "Sessions", children: <SessionsDialogContent /> }) },
  { name: "harness", description: "Switch coding harness (Claude Code, Codex, Cursor…)", value: "/harness", action: (ctx) => ctx.dialog.open({ title: "Select Harness", children: <HarnessDialogContent /> }) },
  { name: "models", description: "Pin a model or let the router choose", value: "/models", action: (ctx) => ctx.dialog.open({ title: "Select Model", children: <ModelsDialogContent /> }) },
  { name: "policy", description: "Routing policy: free, balanced or quality", value: "/policy", action: (ctx) => ctx.dialog.open({ title: "Routing Policy", children: <PolicyDialogContent /> }) },
  { name: "providers", description: "Model providers and what is set up", value: "/providers", action: (ctx) => ctx.dialog.open({ title: "Providers", children: <ProvidersDialogContent /> }) },
  { name: "yolo", description: "Toggle auto-approve for edits and commands", value: "/yolo", action: (ctx) => ctx.toggleYolo() },
  { name: "theme", description: "Change color theme", value: "/theme", action: (ctx) => ctx.dialog.open({ title: "Select Theme", children: <ThemeDialogContent /> }) },
  { name: "exit", description: "Quit the application", value: "/exit", action: (ctx) => ctx.exit() },
];
