package com.example;

import org.springframework.stereotype.Service;
import javax.annotation.Resource;

@Service
public class LegacyService {

    @Resource
    private String dataSource;

    private Thread workerThread;

    public void startWork() {
        workerThread = new Thread(() -> {
            // long-running work
        });
        workerThread.start();
    }

    public void stopWork() {
        if (workerThread != null) {
            // Uses Thread.stop() — throws UnsupportedOperationException since JDK 20
            workerThread.stop();
        }
    }

    @Override
    protected void finalize() throws Throwable {
        // Uses finalize() — deprecated for removal in JDK 18 (JEP-421)
        // Should use java.lang.ref.Cleaner instead
        super.finalize();
    }
}
