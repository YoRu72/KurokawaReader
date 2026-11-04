import java.net.InetAddress;
public class DT { public static void main(String[] a) throws Exception {
  byte[] q = KrDoh.query("example.com", 1); String[] qn = KrDoh.questionOf(q); if (!qn[0].equals("example.com") || !qn[1].equals("1")) throw new Error("questionOf " + qn[0] + " " + qn[1]);
  if (!KrDoh.b64url(new byte[]{(byte)0xfb,(byte)0xff}).equals("-_8")) throw new Error("b64url " + KrDoh.b64url(new byte[]{(byte)0xfb,(byte)0xff}));
  if (!KrDoh.b64url("Man".getBytes()).equals("TWFu") || !KrDoh.b64url("Ma".getBytes()).equals("TWE")) throw new Error("b64url2");
  byte[] m = KrDoh.fromJson("{\"Status\":0,\"Answer\":[{\"name\":\"example.com\",\"type\":1,\"TTL\":1234,\"data\":\"93.184.216.34\"},{\"type\":28,\"TTL\":5,\"data\":\"2606:2800:220:1:248:1893:25c8:1946\"}]}");
  long[] ttl = {300}; InetAddress[] ips = KrDoh.parse(m, ttl); if (ips.length != 2 || !ips[0].getHostAddress().equals("93.184.216.34") || ttl[0] != 5) throw new Error("fromJson " + ips.length + " " + ttl[0]);
  // a fake hello: record header + payload with the host name inside
  String host = "blocked.example"; byte[] name = host.getBytes(); byte[] payload = new byte[120]; for (int i=0;i<payload.length;i++) payload[i]=(byte)i; System.arraycopy(name,0,payload,60,name.length);
  byte[] rec = new byte[5+payload.length]; rec[0]=0x16; rec[1]=3; rec[2]=1; rec[3]=(byte)(payload.length>>8); rec[4]=(byte)payload.length; System.arraycopy(payload,0,rec,5,payload.length);
  byte[][] two = KrDoh.splitHello(rec, 0, rec.length, host); if (two == null) throw new Error("split null");
  int l1 = ((two[0][3]&0xff)<<8)|(two[0][4]&0xff), l2 = ((two[1][3]&0xff)<<8)|(two[1][4]&0xff); if (l1 + l2 != payload.length || two[0].length != 5+l1 || two[1].length != 5+l2) throw new Error("split lens");
  if (!(l1 > 60 && l1 < 60 + name.length)) throw new Error("cut not inside the name: " + l1);
  byte[] joined = new byte[payload.length]; System.arraycopy(two[0],5,joined,0,l1); System.arraycopy(two[1],5,joined,l1,l2); if (!java.util.Arrays.equals(joined, payload)) throw new Error("split bytes");
  if (KrDoh.splitHello(new byte[]{0x17,3,1,0,1,0},0,6,host) != null) throw new Error("not a handshake");
  if (KrDoh.resolvers("auto").size() != 8 || !KrDoh.resolvers("quad9").get(0).id.equals("quad9") || !KrDoh.resolvers("https://x.y/dns-query").get(0).id.equals("custom")) throw new Error("resolvers");
  System.out.println("doh: all passed");
}}
