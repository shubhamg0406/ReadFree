import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Keyboard,
  TouchableWithoutFeedback,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import * as Linking from "expo-linking";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../ThemeContext";
import { spacing, type as T, radius } from "../theme";

function extractUrl(text: string): string | null {
  if (!text) return null;
  const match = text.match(/https?:\/\/[^\s"']+/i);
  if (match) return match[0];
  // bare domain like ft.com/...
  const bare = text.trim();
  if (/^[\w-]+\.[\w.-]+\/\S*/.test(bare)) return "https://" + bare;
  return null;
}

export default function Home() {
  const { mode, colors, toggle } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [url, setUrl] = useState("");
  const [pasting, setPasting] = useState(false);

  const go = useCallback(
    (targetRaw: string) => {
      const target = extractUrl(targetRaw) || targetRaw.trim();
      if (!target || !/^https?:\/\//i.test(target)) {
        Alert.alert("Invalid URL", "Please enter a valid http(s) URL.");
        return;
      }
      router.push({ pathname: "/reader" as any, params: { url: target } });
    },
    [router]
  );

  // Listen for share-intent or deep-link URLs and auto-route to reader.
  useEffect(() => {
    let mounted = true;
    const ownHosts = new Set<string>();
    try {
      if (process.env.EXPO_PUBLIC_BACKEND_URL) {
        ownHosts.add(new URL(process.env.EXPO_PUBLIC_BACKEND_URL).hostname);
      }
    } catch {}
    if (typeof window !== "undefined" && window?.location?.hostname) {
      ownHosts.add(window.location.hostname);
    }

    const isOwnUrl = (u: string) => {
      try {
        const h = new URL(u).hostname;
        return ownHosts.has(h);
      } catch {
        return false;
      }
    };

    const handle = (incoming: string | null) => {
      if (!incoming || !mounted) return;
      // Ignore the app's own URL (happens on web preview / cold start)
      if (incoming.startsWith("readfree://") || incoming.startsWith("exp://")) {
        // Deep link scheme — strip protocol/path to extract shared URL from query
        try {
          const u = new URL(incoming);
          const shared = u.searchParams.get("url") || u.searchParams.get("q");
          if (shared) return handle(decodeURIComponent(shared));
        } catch {}
        return;
      }
      if (isOwnUrl(incoming)) return;
      const extracted = extractUrl(incoming);
      if (extracted && !isOwnUrl(extracted)) {
        router.push({ pathname: "/reader" as any, params: { url: extracted } });
      }
    };

    Linking.getInitialURL().then(handle).catch(() => {});
    const sub = Linking.addEventListener("url", ({ url: u }) => handle(u));
    return () => {
      mounted = false;
      sub.remove();
    };
  }, [router]);

  const handlePaste = useCallback(async () => {
    try {
      setPasting(true);
      // On web, use the browser's navigator.clipboard directly to avoid the
      // expo-clipboard permission round-trip (which surfaces a "denied" toast
      // in Safari). Fail quietly if blocked — user can paste via long-press.
      let txt = "";
      if (Platform.OS === "web") {
        try {
          // @ts-ignore - navigator is available in web runtime
          txt = await (navigator?.clipboard?.readText?.() ?? Promise.resolve(""));
        } catch {
          txt = "";
        }
      } else {
        try {
          txt = await Clipboard.getStringAsync();
        } catch {
          txt = "";
        }
      }
      if (txt) {
        const extracted = extractUrl(txt) || txt;
        setUrl(extracted);
      }
    } finally {
      setPasting(false);
    }
  }, []);

  const handleClear = useCallback(() => setUrl(""), []);

  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: colors.background }]}
      testID="home-screen"
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
          <View style={styles.root}>
            {/* Top bar */}
            <View style={styles.topBar}>
              <Text
                style={[
                  T.caption,
                  { color: colors.textSecondary, letterSpacing: 2 },
                ]}
                testID="app-wordmark"
              >
                READFREE
              </Text>
              <TouchableOpacity
                onPress={toggle}
                activeOpacity={0.7}
                hitSlop={12}
                style={styles.themeToggleBtn}
                testID="theme-toggle-button"
                accessibilityLabel="Toggle theme"
              >
                <Ionicons
                  name={mode === "dark" ? "sunny-outline" : "moon-outline"}
                  size={22}
                  color={colors.textPrimary}
                />
              </TouchableOpacity>
            </View>

            {/* Main column */}
            <View style={styles.column}>
              <Text
                style={[
                  T.h1,
                  { color: colors.textPrimary, marginBottom: 12 },
                ]}
              >
                Read anything.
              </Text>
              <Text
                style={[
                  T.bodyUi,
                  { color: colors.textSecondary, marginBottom: 32 },
                ]}
              >
                Paste a paywalled article URL. We&apos;ll fetch the latest
                archive snapshot and serve it as a clean, distraction-free
                reader.
              </Text>

              {/* Input */}
              <View
                style={[
                  styles.inputWrap,
                  { borderColor: colors.border, backgroundColor: colors.inputBg },
                ]}
              >
                <TextInput
                  value={url}
                  onChangeText={setUrl}
                  placeholder="https://example.com/article"
                  placeholderTextColor={colors.textSecondary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  returnKeyType="go"
                  onSubmitEditing={() => go(url)}
                  style={[
                    styles.input,
                    { color: colors.textPrimary, caretColor: colors.textPrimary } as any,
                  ]}
                  testID="url-input-field"
                  selectionColor={colors.textPrimary}
                  cursorColor={colors.textPrimary}
                  underlineColorAndroid="transparent"
                />
                {url.length > 0 ? (
                  <TouchableOpacity
                    onPress={handleClear}
                    hitSlop={12}
                    style={styles.inputIconBtn}
                    testID="url-clear-button"
                  >
                    <Ionicons
                      name="close-circle"
                      size={20}
                      color={colors.textSecondary}
                    />
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    onPress={handlePaste}
                    hitSlop={12}
                    disabled={pasting}
                    style={styles.inputIconBtn}
                    testID="url-paste-button"
                    accessibilityLabel="Paste from clipboard"
                  >
                    <Ionicons
                      name="clipboard-outline"
                      size={20}
                      color={colors.textPrimary}
                    />
                  </TouchableOpacity>
                )}
              </View>

              {/* Primary button */}
              <TouchableOpacity
                activeOpacity={0.75}
                onPress={() => go(url)}
                style={[
                  styles.primaryBtn,
                  { backgroundColor: colors.brand },
                ]}
                testID="read-submit-button"
              >
                <Text
                  style={[
                    T.bodyUi,
                    {
                      color: colors.brandText,
                      fontWeight: "700",
                      letterSpacing: 1,
                    },
                  ]}
                >
                  READ ARTICLE
                </Text>
              </TouchableOpacity>

              {/* Helper row */}
              <View style={styles.helperRow}>
                <View
                  style={[styles.dot, { backgroundColor: colors.textSecondary }]}
                />
                <Text
                  style={[T.caption, { color: colors.textSecondary }]}
                  testID="home-hint"
                >
                  SHARE ANY LINK TO READFREE
                </Text>
              </View>
            </View>

            {/* Footer tag */}
            <View style={[styles.footer, { paddingBottom: insets.bottom + 8 }]}>
              <Text
                style={[
                  T.caption,
                  { color: colors.textSecondary, opacity: 0.7 },
                ]}
              >
                VIA ARCHIVE.IS / ARCHIVE.PH
              </Text>
            </View>
          </View>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  root: {
    flex: 1,
    paddingHorizontal: spacing.screenH,
    justifyContent: "space-between",
  },
  topBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 8,
    paddingBottom: 24,
  },
  themeToggleBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  column: {
    flex: 1,
    justifyContent: "center",
  },
  inputWrap: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: radius.button,
    paddingHorizontal: 14,
    height: 56,
    marginBottom: 12,
  },
  input: {
    flex: 1,
    fontSize: 16,
    fontFamily: "sans-serif",
    paddingVertical: 0,
  },
  inputIconBtn: {
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  primaryBtn: {
    height: 56,
    borderRadius: radius.button,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  helperRow: {
    marginTop: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
  },
  footer: {
    alignItems: "center",
    paddingTop: 12,
  },
});
