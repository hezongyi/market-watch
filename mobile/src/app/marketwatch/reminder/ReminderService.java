package app.marketwatch.reminder;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.media.*;
import android.net.Uri;
import android.os.*;
import org.json.*;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;

public class ReminderService extends Service {
    private static final String CHANNEL="watch_service";
    private final Handler main=new Handler(Looper.getMainLooper());
    private ScheduledExecutorService network;
    private android.content.SharedPreferences prefs;
    private JSONObject events=new JSONObject(),config=new JSONObject();
    private MediaPlayer player;
    private String playingId="";
    private PowerManager.WakeLock wake;
    private long lastSaved=0;
    private volatile boolean syncing=false;
    private volatile boolean stopped=false;
    private BroadcastReceiver receiver;
    private final Runnable clock=new Runnable(){public void run(){if(stopped)return;tick();main.postDelayed(this,250);}};
    @Override public void onCreate(){
        super.onCreate();prefs=getSharedPreferences("watch",MODE_PRIVATE);
        try{events=new JSONObject(prefs.getString("events","{}"));config=new JSONObject(prefs.getString("config","{}"));}catch(JSONException ignored){}
        NotificationManager nm=getSystemService(NotificationManager.class);NotificationChannel channel=new NotificationChannel(CHANNEL,"守望后台服务",NotificationManager.IMPORTANCE_LOW);channel.setSound(null,null);nm.createNotificationChannel(channel);
        PendingIntent open=PendingIntent.getActivity(this,0,new Intent(this,MainActivity.class),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification=new Notification.Builder(this,CHANNEL).setSmallIcon(android.R.drawable.ic_lock_idle_alarm).setContentTitle("守望提醒正在运行").setContentText("保持后台运行，点击查看并确认事件").setContentIntent(open).setOngoing(true).build();
        if(Build.VERSION.SDK_INT>=34)startForeground(1,notification,ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);else startForeground(1,notification);
        wake=((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"MarketWatch:PendingAlert");
        network=Executors.newSingleThreadScheduledExecutor();network.scheduleWithFixedDelay(this::sync,0,5,TimeUnit.SECONDS);
        receiver=new BroadcastReceiver(){@Override public void onReceive(Context c,Intent i){if("io.heckel.ntfy.MESSAGE_RECEIVED".equals(i.getAction()))network.execute(ReminderService.this::sync);}};
        IntentFilter filter=new IntentFilter("io.heckel.ntfy.MESSAGE_RECEIVED");if(Build.VERSION.SDK_INT>=33)registerReceiver(receiver,filter,Context.RECEIVER_EXPORTED);else registerReceiver(receiver,filter);
        main.post(clock);
    }
    @Override public int onStartCommand(Intent i,int flags,int startId){
        if(i!=null&&"ack".equals(i.getAction())){String id=i.getStringExtra("id");try{JSONObject e=events.optJSONObject(id);if(e!=null){e.put("acked",true);e.put("ack_pending",true);stopAudio();save();network.execute(this::sync);}}catch(JSONException ignored){}}
        return START_STICKY;
    }
    @Override public IBinder onBind(Intent i){return null;}
    private synchronized String request(String path,boolean post)throws Exception{
        String base=prefs.getString("server",""),token=prefs.getString("token","");if(!base.startsWith("https://")||token.isEmpty())throw new IOException("请先配置 HTTPS 网站地址和令牌");
        HttpURLConnection c=(HttpURLConnection)new URL(base+path).openConnection();c.setConnectTimeout(7000);c.setReadTimeout(7000);c.setInstanceFollowRedirects(false);c.setRequestProperty("Authorization","Bearer "+token);c.setRequestProperty("Accept","application/json");if(post)c.setRequestMethod("POST");
        try{int code=c.getResponseCode();if(code!=200)throw new IOException("HTTP "+code);try(InputStream in=c.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] b=new byte[8192];int n,total=0;while((n=in.read(b))!=-1){total+=n;if(total>2_000_000)throw new IOException("响应过大");out.write(b,0,n);}return out.toString("UTF-8");}}finally{c.disconnect();}
    }
    private void sync(){
        if(stopped||syncing)return;syncing=true;
        try{
            JSONObject snapshot=new JSONObject(prefs.getString("events","{}"));Iterator<String> ids=snapshot.keys();List<String> confirmed=new ArrayList<>();
            while(ids.hasNext()){String id=ids.next();if(snapshot.getJSONObject(id).optBoolean("ack_pending")){request("/api/device/notifications/"+id+"/ack",true);confirmed.add(id);}}
            JSONObject data=new JSONObject(request("/api/device/sync",false));JSONArray incoming=data.getJSONArray("events");
            for(int j=0;j<incoming.length();j++){String id=incoming.getJSONObject(j).getString("id");JSONObject existing=snapshot.optJSONObject(id);if(existing==null||!existing.optBoolean("receipt_sent"))request("/api/device/notifications/"+id+"/received",true);}
            main.post(()->{if(stopped)return;try{
                if(data.optBoolean("pending_snapshot_complete")){
                    Set<String> active=new HashSet<>();for(int j=0;j<incoming.length();j++)active.add(incoming.getJSONObject(j).getString("id"));
                    Iterator<String> localIds=events.keys();while(localIds.hasNext()){String id=localIds.next();if(!active.contains(id))events.getJSONObject(id).put("acked",true);}
                }
                config=data.getJSONObject("config");JSONArray acked=data.getJSONArray("acked");for(int j=0;j<acked.length();j++){JSONObject e=events.optJSONObject(acked.getString(j));if(e!=null)e.put("acked",true);}
                for(String id:confirmed){JSONObject e=events.optJSONObject(id);if(e!=null)e.put("ack_pending",false);}
                for(int j=0;j<incoming.length();j++){JSONObject e=incoming.getJSONObject(j);String id=e.getString("id");JSONObject existing=events.optJSONObject(id);if(existing==null){e.put("count",0);e.put("next_at",0);e.put("ringing",false);events.put(id,e);}events.getJSONObject(id).put("receipt_sent",true);}
                prefs.edit().putString("status","已连接 · "+LocalTime.now().withNano(0)+" · "+("companion".equals(config.optString("mode"))?"节奏提醒已启用":"请在网站选择配套客户端模式")).apply();save();tick();
            }catch(JSONException e){prefs.edit().putString("status","服务器数据格式错误").apply();}});
        }catch(Exception e){prefs.edit().putString("status","暂未连接："+e.getMessage()+"；已接收提醒仍按本地设置运行").apply();}
        finally{syncing=false;}
    }
    private boolean quiet(){
        if(!config.optBoolean("quiet_enabled"))return false;
        try{LocalTime now=ZonedDateTime.now(ZoneId.of(config.optString("timezone","Asia/Shanghai"))).toLocalTime();LocalTime start=LocalTime.parse(config.optString("quiet_start","23:00")),end=LocalTime.parse(config.optString("quiet_end","07:00"));return start.isBefore(end)?!now.isBefore(start)&&now.isBefore(end):!now.isBefore(start)||now.isBefore(end);}catch(Exception e){return true;}
    }
    private void tick(){
        if(stopped)return;
        long now=System.currentTimeMillis();String desired="";boolean pending=false;
        try{Iterator<String> keys=events.keys();while(keys.hasNext()){String id=keys.next();JSONObject e=events.getJSONObject(id);if(e.optBoolean("acked")||e.optBoolean("exhausted"))continue;pending=true;if(!"companion".equals(config.optString("mode")))break;
            RingEngine r=new RingEngine();r.count=e.optInt("count");r.ringing=e.optBoolean("ringing");r.quiet=e.optBoolean("quiet");r.nextAt=e.optLong("next_at");
            boolean sound=r.tick(now,quiet(),config.optInt("ring_seconds",15),config.optInt("repeat_seconds",30),config.optInt("max_repeats",0));
            e.put("count",r.count);e.put("ringing",r.ringing);e.put("quiet",r.quiet);e.put("next_at",r.nextAt);e.put("exhausted",r.exhausted);if(sound)desired=id;break;
        }}catch(JSONException e){prefs.edit().putString("status","本地提醒状态错误").apply();}
        if(pending&&"companion".equals(config.optString("mode"))){if(!wake.isHeld())wake.acquire(10*60*1000L);}else if(wake.isHeld())wake.release();
        if(!desired.equals(playingId)){stopAudio();if(!desired.isEmpty())startAudio(desired);}
        if(now-lastSaved>1000){save();lastSaved=now;}
    }
    private void startAudio(String id){try{Uri uri=Uri.parse(prefs.getString("ringtone",RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM).toString()));player=new MediaPlayer();player.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());player.setDataSource(this,uri);player.setLooping(true);player.prepare();player.start();playingId=id;}catch(Exception e){stopAudio();prefs.edit().putString("status","铃声无法播放，请重新选择铃声："+e.getMessage()).apply();}}
    private void stopAudio(){if(player!=null){try{player.stop();}catch(Exception ignored){}player.release();player=null;}playingId="";}
    private void save(){prefs.edit().putString("events",events.toString()).putString("config",config.toString()).apply();}
    @Override public void onDestroy(){stopped=true;main.removeCallbacksAndMessages(null);if(receiver!=null)unregisterReceiver(receiver);if(network!=null)network.shutdownNow();stopAudio();if(wake!=null&&wake.isHeld())wake.release();save();super.onDestroy();}
}
