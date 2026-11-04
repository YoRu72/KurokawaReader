package org.json;
import java.util.*;
public class JSONArray { List<Object> l=new ArrayList<>(); public JSONArray put(Object o){l.add(o);return this;} public int length(){return l.size();} public JSONObject getJSONObject(int i){return (JSONObject)l.get(i);} public JSONObject optJSONObject(int i){Object o=l.get(i);return o instanceof JSONObject?(JSONObject)o:null;} public String toString(){return l.toString();} }
