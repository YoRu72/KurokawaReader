package app.kurokawa.tools;

/** tests/browsewalk.cjs's driver for KtWebRules: one typed text a line on stdin, its address a line on stdout. */
public class WebT {
    public static void main(String[] a) throws Exception {
        java.io.BufferedReader in = new java.io.BufferedReader(new java.io.InputStreamReader(System.in, java.nio.charset.StandardCharsets.UTF_8));
        java.io.PrintStream out = new java.io.PrintStream(System.out, true, "UTF-8"); String l;
        while ((l = in.readLine()) != null) out.println(KtWebRules.addressOf(l, "S:"));
    }
}
