package pl.michwie.planszowki;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Po zainstalowaniu nowej wersji uruchamia aplikację ponownie (o ile Android na to pozwala). */
public class UpdatedReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        try {
            Intent i = new Intent(context, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            context.startActivity(i);
        } catch (Exception ignored) { }
    }
}
