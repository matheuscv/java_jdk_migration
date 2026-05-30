package com.example;

import sun.misc.BASE64Encoder;
import sun.misc.BASE64Decoder;
import sun.audio.AudioPlayer;
import java.util.Observer;
import java.util.Observable;

/**
 * Aplicação legada JDK 6.
 * Contém múltiplas APIs removidas no caminho JDK 6 → JDK 21.
 */
public class App implements Observer {

    public static void main(String[] args) throws Exception {
        // sun.misc.BASE64Encoder — removido no JDK 9
        BASE64Encoder encoder = new BASE64Encoder();
        BASE64Decoder decoder = new BASE64Decoder();
        String encoded = encoder.encode("hello".getBytes());
        byte[] decoded = decoder.decodeBuffer(encoded);

        System.out.println("Encoded: " + encoded);
        System.out.println("Decoded: " + new String(decoded));
    }

    @Override
    public void update(Observable o, Object arg) {
        // java.util.Observer — deprecado no JDK 9
    }

    @Override
    protected void finalize() throws Throwable {
        // finalize() — deprecado para remoção no JDK 18
        super.finalize();
    }
}
