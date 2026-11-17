package pl.michwie.planszowki;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

/** Status instalacji aktualizacji (PackageInstaller). */
public class InstallReceiver extends BroadcastReceiver {
    @Override
    @SuppressWarnings("deprecation")
    public void onReceive(Context context, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        MainActivity a = MainActivity.current.get();
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            // pierwsza aktualizacja tym sposobem: system prosi o potwierdzenie
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) {
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try { context.startActivity(confirm); } catch (Exception ignored) { }
            }
            if (a != null) a.js("window.updProgress&&updProgress(-3)");
        } else if (status == PackageInstaller.STATUS_SUCCESS) {
            if (a != null) a.js("window.updProgress&&updProgress(-5)");
        } else if (a != null) {
            a.js("window.updProgress&&updProgress(" + (status == PackageInstaller.STATUS_FAILURE_ABORTED ? -6 : -4) + ")");
        }
    }
}
