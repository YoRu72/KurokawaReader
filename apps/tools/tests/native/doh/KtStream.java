import java.io.*;
public final class KtStream { static String readLine(InputStream in) throws IOException { ByteArrayOutputStream b = new ByteArrayOutputStream(); int c; while ((c = in.read()) >= 0) { if (c == '\n') break; if (c != '\r') b.write(c); } return c < 0 && b.size() == 0 ? null : b.toString("ISO-8859-1"); } }
