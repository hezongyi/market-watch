package app.marketwatch.reminder;

import android.Manifest;
import android.app.*;
import android.os.*;
import android.content.*;
import android.graphics.Color;
import android.media.RingtoneManager;
import android.net.Uri;
import android.text.InputType;
import android.view.View;
import android.widget.*;
import org.json.*;

public class MainActivity extends Activity {
    private EditText server,token;
    private LinearLayout events;
    private TextView status;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final Runnable refresh=new Runnable(){public void run(){renderEvents();handler.postDelayed(this,2000);}};
    private android.content.SharedPreferences prefs(){return getSharedPreferences("watch",MODE_PRIVATE);}
    private TextView text(String value,int size){TextView t=new TextView(this);t.setText(value);t.setTextSize(size);t.setTextColor(Color.rgb(37,51,42));t.setPadding(0,12,0,12);return t;}
    private Button button(String title,View.OnClickListener action){Button b=new Button(this);b.setText(title);b.setOnClickListener(action);return b;}
    @Override public void onCreate(Bundle state){
        super.onCreate(state);
        if(Build.VERSION.SDK_INT>=33)requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},1);
        ScrollView scroll=new ScrollView(this);LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setPadding(36,50,36,40);root.setBackgroundColor(Color.rgb(245,246,242));scroll.addView(root);setContentView(scroll);
        root.addView(text("守望提醒",28));root.addView(text("由 ntfy 唤醒，按你的节奏提醒。开启后保持后台运行，不要划掉应用。",14));
        root.addView(text("网站地址（HTTPS）",14));server=new EditText(this);server.setSingleLine();server.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_URI);server.setText(prefs().getString("server",""));root.addView(server);
        root.addView(text("设备配对令牌",14));token=new EditText(this);token.setSingleLine();token.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);token.setText(prefs().getString("token",""));root.addView(token);
        root.addView(button("保存并开启提醒",v->{String url=server.getText().toString().trim().replaceAll("/+$","");if(!url.startsWith("https://")||token.getText().length()<20){Toast.makeText(this,"请输入 HTTPS 网站地址和有效配对令牌",Toast.LENGTH_LONG).show();return;}prefs().edit().putString("server",url).putString("token",token.getText().toString().trim()).apply();startForegroundService(new Intent(this,ReminderService.class));}));
        root.addView(button("选择提醒铃声",v->{Intent i=new Intent(RingtoneManager.ACTION_RINGTONE_PICKER);i.putExtra(RingtoneManager.EXTRA_RINGTONE_TYPE,RingtoneManager.TYPE_ALARM);i.putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_SILENT,false);i.putExtra(RingtoneManager.EXTRA_RINGTONE_EXISTING_URI,Uri.parse(prefs().getString("ringtone",RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM).toString())));startActivityForResult(i,2);}));
        root.addView(button("停止后台提醒",v->{stopService(new Intent(this,ReminderService.class));prefs().edit().putString("status","已停止，需要手动重新开启").apply();renderEvents();}));
        status=text("尚未连接",13);root.addView(status);root.addView(text("待确认事件",20));events=new LinearLayout(this);events.setOrientation(LinearLayout.VERTICAL);root.addView(events);
        root.addView(text("设置页切换为配套客户端模式，并将 ntfy 的对应主题设为静音，避免两套铃声同时播放。勿扰和系统闹钟音量由手机设置控制。",12));
    }
    @Override protected void onActivityResult(int req,int result,Intent data){super.onActivityResult(req,result,data);if(req==2&&result==RESULT_OK&&data!=null){Uri uri=data.getParcelableExtra(RingtoneManager.EXTRA_RINGTONE_PICKED_URI);if(uri!=null)prefs().edit().putString("ringtone",uri.toString()).apply();}}
    @Override protected void onResume(){super.onResume();handler.post(refresh);}
    @Override protected void onPause(){super.onPause();handler.removeCallbacks(refresh);}
    private void renderEvents(){
        if(events==null)return;events.removeAllViews();status.setText(prefs().getString("status","尚未连接"));
        try{JSONObject all=new JSONObject(prefs().getString("events","{}"));java.util.Iterator<String> keys=all.keys();int n=0;while(keys.hasNext()){String id=keys.next();JSONObject e=all.getJSONObject(id);if(e.optBoolean("acked"))continue;n++;events.addView(text(e.optString("title"),17));events.addView(text(e.optString("message")+(e.optBoolean("exhausted")?"\n已达到提醒次数，仍待确认":""),13));events.addView(button("确认已看到",v->{Intent i=new Intent(this,ReminderService.class);i.setAction("ack");i.putExtra("id",id);startForegroundService(i);}));}if(n==0)events.addView(text("暂无待确认事件",14));}catch(JSONException e){status.setText("本地状态读取失败，请重新开启提醒");}
    }
}
