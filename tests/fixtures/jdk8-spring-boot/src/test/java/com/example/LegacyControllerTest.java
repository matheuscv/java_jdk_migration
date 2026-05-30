package com.example;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.springframework.test.context.junit4.SpringRunner;
import static org.junit.Assert.assertNotNull;

// JUnit 4 — deve ser migrado para JUnit 5 na Fase 2
@RunWith(SpringRunner.class)
public class LegacyControllerTest {

    private LegacyController controller;

    @Before
    public void setUp() {
        controller = new LegacyController();
    }

    @Test
    public void controllerShouldNotBeNull() {
        assertNotNull(controller);
    }
}
