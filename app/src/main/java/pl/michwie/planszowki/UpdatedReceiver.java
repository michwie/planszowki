package pl.michwie.planszowki;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Po zainstalowaniu nowej wersji: powiadomienie „Planszomat zaktualizowany – dotknij, aby otworzyć”.
 * (Android nie pozwala aplikacji samej wyskoczyć na ekran, ale dotknięcie powiadomienia ją otwiera.)
 */
public class UpdatedReceiver extends BroadcastReceiver {
    static final String CHANNEL = "updates";
    static final int NOTIF_ID = 4711;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        try {
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Aktualizacje", NotificationManager.IMPORTANCE_HIGH));
            Intent open = new Intent(context, MainActivity.class);
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent pi = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification n = new Notification.Builder(context, CHANNEL)
                    .setSmallIcon(android.R.drawable.stat_sys_download_done)
                    .setContentTitle("Planszomat zaktualizowany")
                    .setContentText("Wersja " + BuildConfig.VERSION_NAME + " – dotknij, aby otworzyć")
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .build();
            nm.notify(NOTIF_ID, n);
        } catch (Exception ignored) { }
    }
}
