package com.openrealm.data.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonInclude.Include;
import com.openrealm.game.data.GameDataManager;
import com.openrealm.game.model.CharacterClassModel;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.EqualsAndHashCode;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
@JsonInclude(Include.NON_NULL)
@JsonIgnoreProperties(ignoreUnknown = true)
@EqualsAndHashCode(callSuper=false)
public class CharacterStatsDto extends TemporalDto{
	private static final long serialVersionUID = -966774703891631356L;

	private String characterStatsId;
	private Long xp;
	private Integer classId;
	private Integer hp;
	private Integer mp;
	private Integer def;
	private Integer att;
	private Integer spd;
	private Integer dex;
	private Integer vit;
	private Integer wis;

	// Cosmetic "dye id" — opaque integer keyed in the client's
	// dye-assets.json registry. The registry maps id → recolor strategy
	// (solid color, gradient, patterned cloth, etc.) so adding new cosmetics
	// later doesn't require a wire-format change. 0 / null = no dye.
	// Cleared on character death (character is deleted on permadeath).
	private Integer dyeId;


	public static CharacterStatsDto characterDefaults(final Integer characterClass) {
		final CharacterClassModel model = GameDataManager.CHARACTER_CLASSES.get(characterClass);
		return CharacterStatsDto.builder()
				.xp(0l)
				.hp((int)model.getBaseStats().getHp())
				.mp((int)model.getBaseStats().getMp())
				.def((int)model.getBaseStats().getDef())
				.att((int)model.getBaseStats().getAtt())
				.spd((int)model.getBaseStats().getSpd())
				.dex((int)model.getBaseStats().getDex())
				.vit((int)model.getBaseStats().getVit())
				.wis((int)model.getBaseStats().getWis())
				.build();
	}
}
