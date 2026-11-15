// Writes kt-core/src/javachar.in (stage M4): Java's Character.isLetter / isDigit over every code point and
// toLowerCase(char) over the BMP, as range tables, with a checksum the Rust tests compare. Run: java GenJavaChar.java > ../../kt-core/src/javachar.in
public class GenJavaChar {
  static void ranges(String name, java.util.function.IntPredicate p, int max) {
    StringBuilder b = new StringBuilder("const " + name + ": &[(u32, u32)] = &[");
    int n = 0; int c = 0;
    while (c <= max) { if (!p.test(c)) { c++; continue; } int s = c; while (c <= max && p.test(c)) c++; if (n++ % 6 == 0) b.append("\n    "); b.append("(0x").append(Integer.toHexString(s)).append(", 0x").append(Integer.toHexString(c - 1)).append("), "); }
    b.append("\n];\n"); System.out.print(b); System.err.println(name + " " + n);
  }
  public static void main(String[] a) {
    System.out.println("// Generated from Java " + Runtime.version().feature() + " (its Character class: isLetter, isDigit, toLowerCase(char)) by kt-android/jvmtest/GenJavaChar.java; do not edit by hand.");
    ranges("J_LETTER", Character::isLetter, 0x10FFFF);
    ranges("J_DIGIT", Character::isDigit, 0x10FFFF);
    // \p{N}: Nd, Nl, No
    // toLowerCase(char): runs (start, end, delta, step) where lower(c) = c + delta for c in start..=end step `step`
    StringBuilder b = new StringBuilder("const J_LOWER: &[(u16, u16, i32, u16)] = &["); int n = 0;
    int c = 0; while (c <= 0xFFFF) {
      int d = Character.toLowerCase((char) c) - c; if (d == 0) { c++; continue; }
      int s = c, step = 1;
      // try step 2 (alternating upper/lower) or step 1
      int e = c;
      if (c + 2 <= 0xFFFF && Character.toLowerCase((char) (c + 1)) - (c + 1) != d && Character.toLowerCase((char) (c + 2)) - (c + 2) == d && Character.toLowerCase((char)(c+1)) == c+1) { step = 2; while (e + 2 <= 0xFFFF && Character.toLowerCase((char) (e + 2)) - (e + 2) == d && Character.toLowerCase((char)(e+1)) == e+1) e += 2; }
      else { while (e + 1 <= 0xFFFF && Character.toLowerCase((char) (e + 1)) - (e + 1) == d) e++; }
      if (n++ % 4 == 0) b.append("\n    "); b.append("(0x").append(Integer.toHexString(s)).append(", 0x").append(Integer.toHexString(e)).append(", ").append(d).append(", ").append(step).append("), ");
      c = e + 1;
    }
    b.append("\n];\n"); System.out.print(b); System.err.println("lower " + n);
    long h = 0xcbf29ce484222325L; for (int k = 0; k <= 0x10FFFF; k++) { long v = (k <= 0xFFFF ? Character.toLowerCase((char) k) : 0) * 4L + (Character.isLetter(k) ? 2 : 0) + (Character.isDigit(k) ? 1 : 0); h = (h ^ v) * 0x100000001b3L; }
    System.out.println("#[allow(dead_code)]\nconst J_TABLES_CHECK: u64 = 0x" + Long.toHexString(h) + ";");
  }
}
