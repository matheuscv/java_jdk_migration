package com.example;

import org.junit.Test;
import static org.junit.Assert.assertNotNull;

// JUnit 4 — deve ser migrado para JUnit 5 na Fase 2 (UpgradeToJava21 inclui essa migração)
public class HelloControllerTest {

    @Test
    public void contextLoads() {
        // Smoke test mínimo
        assertNotNull(new HelloController());
    }
}
