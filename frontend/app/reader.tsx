import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Animated,
  useWindowDimensions,
  Linking,
  Alert,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import RenderHtml, { MixedStyleDeclaration, defaultSystemFonts } from "react-native-render-html";
import { WebView, WebViewNavigation } from "react-native-webview";
import { useTheme } from "../ThemeContext";
import { spacing, type as T, radius } from "../theme";

type ResolveResponse = {
  title: string;
  content_html: string;
  source_url: string;
  source_domain: string;
  snapshot_url: string;
  byline?: string | null;
};

type Stage =
  | "server_try"
  | "webview_index"
  | "webview_snapshot"
  | "extracting"
  | "ready"
  | "error";

const API_BASE = process.env.EXPO_PUBLIC_BACKEND_URL;
const SNAPSHOT_RE = /^https?:\/\/archive\.(?:is|ph|today|li|md|vn|fo)\/[A-Za-z0-9]{4,8}\/?$/;

// JS injected into the hidden WebView to detect page type + report back.
const PROBE_JS = `
(function(){
  try {
    var href = window.location.href.replace(/\\/$/, '');
    var snapRe = /^https?:\\/\\/archive\\.(is|ph|today|li|md|vn|fo)\\/[A-Za-z0-9]{4,8}$/;
    function post(m){ window.ReactNativeWebView.postMessage(JSON.stringify(m)); }
    // Captcha page?
    if (document.querySelector('.g-recaptcha') || /Please enable JavaScript to view/i.test(document.body.innerText||'')) {
      post({ type: 'captcha', url: href });
      return;
    }
    if (snapRe.test(href)) {
      // Full snapshot — extract HTML after a small delay to let lazy images settle.
      setTimeout(function(){
        post({ type: 'snapshot_html', url: href, html: document.documentElement.outerHTML });
      }, 600);
      return;
    }
    // Otherwise we're on an index page. Find first snapshot link.
    var links = document.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var h = links[i].href.replace(/\\/$/, '');
      if (snapRe.test(h)) { post({ type: 'snapshot_link', url: h }); return; }
    }
    post({ type: 'no_snapshot', url: href });
  } catch (e) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'probe_error', message: String(e) }));
  }
})(); true;
`;

function TypographicPulse({ text, color }: { text: string; color: string }) {
  const opacity = useRef(new Animated.Value(0.35)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.35, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return (
    <Animated.Text style={[T.caption, { color, letterSpacing: 3, opacity }]} testID="loading-indicator">
      {text}
    </Animated.Text>
  );
}

export default function Reader() {
  const { mode, colors, toggle } = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { url } = useLocalSearchParams<{ url: string }>();

  const [stage, setStage] = useState<Stage>("server_try");
  const [data, setData] = useState<ResolveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [webviewUri, setWebviewUri] = useState<string | null>(null);
  const snapshotUrlRef = useRef<string | null>(null);
  const webviewRef = useRef<WebView | null>(null);
  const postedHtmlRef = useRef(false);

  const finishWithError = useCallback((msg: string) => {
    setError(msg);
    setStage("error");
  }, []);

  const tryServerResolve = useCallback(async () => {
    if (!url) {
      finishWithError("No URL provided.");
      return;
    }
    setStage("server_try");
    setError(null);
    setData(null);
    postedHtmlRef.current = false;
    snapshotUrlRef.current = null;
    try {
      const res = await fetch(`${API_BASE}/api/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setData(body as ResolveResponse);
        setStage("ready");
        return;
      }
      // 451 = server blocked by archive.is -> try client-side webview
      if (res.status === 451 || res.status === 502 || res.status === 429) {
        setWebviewUri(`https://archive.ph/newest/${encodeURI(url)}`);
        setStage("webview_index");
        return;
      }
      if (res.status === 404) {
        finishWithError("No archived version found for this article.");
        return;
      }
      finishWithError(String(body?.detail || "Could not reach archive. Check your connection."));
    } catch {
      // Network error to our backend — try on-device fetch anyway
      setWebviewUri(`https://archive.ph/newest/${encodeURI(url as string)}`);
      setStage("webview_index");
    }
  }, [url, finishWithError]);

  useEffect(() => {
    tryServerResolve();
  }, [tryServerResolve]);

  const extractFromHtml = useCallback(
    async (html: string, snapshotUrl: string) => {
      setStage("extracting");
      try {
        const res = await fetch(`${API_BASE}/api/extract`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ html, url, snapshot_url: snapshotUrl }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          finishWithError(String(body?.detail || "Could not extract article content."));
          return;
        }
        setData(body as ResolveResponse);
        setStage("ready");
      } catch {
        finishWithError("Could not reach archive. Check your connection.");
      }
    },
    [url, finishWithError]
  );

  const onWebviewMessage = useCallback(
    (e: { nativeEvent: { data: string } }) => {
      let msg: any;
      try {
        msg = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }
      if (msg.type === "snapshot_link") {
        snapshotUrlRef.current = msg.url;
        setStage("webview_snapshot");
        setWebviewUri(msg.url);
      } else if (msg.type === "snapshot_html") {
        if (postedHtmlRef.current) return;
        postedHtmlRef.current = true;
        extractFromHtml(msg.html, msg.url || snapshotUrlRef.current || "");
      } else if (msg.type === "no_snapshot") {
        finishWithError("No archived version found for this article.");
      } else if (msg.type === "captcha") {
        finishWithError(
          "archive.is is showing a challenge page. Try again in a minute or open the snapshot link manually."
        );
      }
    },
    [extractFromHtml, finishWithError]
  );

  const onWebviewNav = useCallback((nav: WebViewNavigation) => {
    // Auto-detect if archive redirects us straight to a snapshot URL.
    const clean = (nav.url || "").replace(/\/$/, "");
    if (SNAPSHOT_RE.test(clean) && snapshotUrlRef.current !== clean) {
      snapshotUrlRef.current = clean;
      if (stage === "webview_index") setStage("webview_snapshot");
    }
  }, [stage]);

  const domain = useMemo(() => {
    if (data?.source_domain) return data.source_domain.toUpperCase();
    if (!url) return "";
    try {
      return new URL(url as string).hostname.replace(/^www\./, "").toUpperCase();
    } catch {
      return "";
    }
  }, [data, url]);

  const htmlStyles = useMemo<Record<string, MixedStyleDeclaration>>(
    () => ({
      body: { color: colors.textPrimary, fontFamily: "serif", fontSize: 18, lineHeight: 28 },
      p: { color: colors.textPrimary, fontFamily: "serif", fontSize: 18, lineHeight: 28, marginBottom: 18 },
      h1: { color: colors.textPrimary, fontFamily: "serif", fontSize: 26, lineHeight: 34, fontWeight: "700", marginTop: 16, marginBottom: 12 },
      h2: { color: colors.textPrimary, fontFamily: "serif", fontSize: 22, lineHeight: 30, fontWeight: "700", marginTop: 20, marginBottom: 10 },
      h3: { color: colors.textPrimary, fontFamily: "serif", fontSize: 20, lineHeight: 28, fontWeight: "700", marginTop: 18, marginBottom: 8 },
      a: { color: colors.textPrimary, textDecorationLine: "underline" },
      blockquote: {
        color: colors.textSecondary,
        fontStyle: "italic",
        borderLeftWidth: 3,
        borderLeftColor: colors.border,
        paddingLeft: 14,
        marginVertical: 16,
      },
      li: { color: colors.textPrimary, fontFamily: "serif", fontSize: 18, lineHeight: 28, marginBottom: 6 },
      figure: { marginVertical: 16 },
      figcaption: { color: colors.textSecondary, fontFamily: "sans-serif", fontSize: 13, lineHeight: 18, marginTop: 6 },
      img: { marginVertical: 12, borderRadius: radius.sm },
      em: { fontStyle: "italic" },
      strong: { fontWeight: "700" },
      hr: { borderBottomWidth: 1, borderBottomColor: colors.border, marginVertical: 24 },
    }),
    [colors]
  );

  const openSnapshot = useCallback(() => {
    if (!data?.snapshot_url) return;
    Linking.openURL(data.snapshot_url).catch(() => Alert.alert("Unable to open snapshot"));
  }, [data]);

  const loadingLabel =
    stage === "server_try"
      ? "FINDING SNAPSHOT…"
      : stage === "webview_index"
      ? "RESOLVING ARCHIVE…"
      : stage === "webview_snapshot"
      ? "LOADING SNAPSHOT…"
      : "EXTRACTING ARTICLE…";

  const isLoading = stage !== "ready" && stage !== "error";

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} testID="reader-screen">
      {/* Top bar */}
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={14}
          activeOpacity={0.7}
          style={styles.iconBtn}
          testID="reader-back-button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text
          numberOfLines={1}
          ellipsizeMode="middle"
          style={[T.caption, { color: colors.textSecondary }]}
          testID="reader-source-domain"
        >
          {domain || "READFREE"}
        </Text>
        <TouchableOpacity
          onPress={toggle}
          hitSlop={14}
          activeOpacity={0.7}
          style={styles.iconBtn}
          testID="reader-theme-toggle"
          accessibilityLabel="Toggle theme"
        >
          <Ionicons name={mode === "dark" ? "sunny-outline" : "moon-outline"} size={22} color={colors.textPrimary} />
        </TouchableOpacity>
      </View>

      {/* Hidden WebView for on-device archive fetch (native only) */}
      {Platform.OS !== "web" && webviewUri && stage !== "ready" && stage !== "error" && (
        <View style={styles.hiddenWebview} pointerEvents="none">
          <WebView
            ref={webviewRef}
            source={{ uri: webviewUri }}
            onMessage={onWebviewMessage}
            onNavigationStateChange={onWebviewNav}
            injectedJavaScript={PROBE_JS}
            javaScriptEnabled
            domStorageEnabled
            thirdPartyCookiesEnabled
            cacheEnabled
            originWhitelist={["*"]}
            userAgent={
              "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36"
            }
            onError={() => finishWithError("Could not reach archive. Check your connection.")}
          />
        </View>
      )}

      {isLoading ? (
        <View style={styles.centered} testID="loading-state">
          <ActivityIndicator size="small" color={colors.textPrimary} />
          <View style={{ height: 16 }} />
          <TypographicPulse text={loadingLabel} color={colors.textSecondary} />
          <Text
            style={[
              T.bodyUi,
              { color: colors.textSecondary, textAlign: "center", marginTop: 20, paddingHorizontal: 32, fontSize: 13 },
            ]}
            numberOfLines={2}
          >
            {url}
          </Text>
        </View>
      ) : stage === "error" ? (
        <View style={styles.centered} testID="error-message">
          <View style={[styles.errorBadge, { borderColor: colors.error }]}>
            <Ionicons name="alert-circle-outline" size={28} color={colors.error} />
          </View>
          <Text style={[T.h2, { color: colors.textPrimary, textAlign: "center", marginTop: 18 }]}>
            Something went wrong
          </Text>
          <Text
            style={[
              T.bodyUi,
              { color: colors.textSecondary, textAlign: "center", marginTop: 8, paddingHorizontal: 24 },
            ]}
            testID="error-detail"
          >
            {error}
          </Text>
          <View style={styles.errorActions}>
            <TouchableOpacity
              activeOpacity={0.75}
              onPress={tryServerResolve}
              style={[styles.primaryBtn, { backgroundColor: colors.brand }]}
              testID="reader-retry-button"
            >
              <Text style={[T.bodyUi, { color: colors.brandText, fontWeight: "700", letterSpacing: 1 }]}>
                TRY AGAIN
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              activeOpacity={0.75}
              onPress={() => router.back()}
              style={[styles.secondaryBtn, { borderColor: colors.border }]}
              testID="reader-error-back"
            >
              <Text style={[T.bodyUi, { color: colors.textPrimary, fontWeight: "600", letterSpacing: 1 }]}>
                BACK
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : data ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          testID="article-scroll-view"
        >
          <Text style={[T.caption, { color: colors.textSecondary, marginBottom: 10 }]}>{domain}</Text>
          <Text style={[T.h2, { color: colors.textPrimary, marginBottom: 16 }]} testID="article-title">
            {data.title}
          </Text>
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <View testID="article-content">
            <RenderHtml
              contentWidth={width - spacing.readerH * 2}
              source={{ html: data.content_html }}
              tagsStyles={htmlStyles}
              systemFonts={[...defaultSystemFonts, "serif", "sans-serif"]}
              defaultTextProps={{ selectable: true }}
              enableExperimentalMarginCollapsing
              renderersProps={{
                img: { enableExperimentalPercentWidth: true },
                a: {
                  onPress: (_e, href) => {
                    if (href) Linking.openURL(href).catch(() => {});
                  },
                },
              }}
            />
          </View>
          <TouchableOpacity
            onPress={openSnapshot}
            activeOpacity={0.75}
            style={[styles.snapshotLink, { borderColor: colors.border }]}
            testID="open-snapshot"
          >
            <Ionicons name="open-outline" size={16} color={colors.textSecondary} />
            <Text style={[T.caption, { color: colors.textSecondary, marginLeft: 8 }]}>
              OPEN FULL SNAPSHOT
            </Text>
          </TouchableOpacity>
          <View style={{ height: 40 }} />
        </ScrollView>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    height: 52,
    borderBottomWidth: 1,
  },
  iconBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  errorBadge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  errorActions: { marginTop: 28, width: "100%", gap: 12, paddingHorizontal: 12 },
  primaryBtn: { height: 52, borderRadius: radius.button, alignItems: "center", justifyContent: "center" },
  secondaryBtn: {
    height: 52,
    borderRadius: radius.button,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  scrollContent: { paddingHorizontal: spacing.readerH, paddingTop: 24, paddingBottom: 32 },
  divider: { height: 1, marginBottom: 20 },
  snapshotLink: {
    marginTop: 32,
    paddingVertical: 14,
    borderTopWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  hiddenWebview: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
    top: -1000,
    left: -1000,
  },
});
