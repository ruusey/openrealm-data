package com.openrealm.data.entity;

import java.io.Serializable;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class EnchantmentEntity implements Serializable {
    private static final long serialVersionUID = 1L;

    private Byte statId;
    private Byte deltaValue;
    private Byte pixelX;
    private Byte pixelY;
    private Integer pixelColor;
}
