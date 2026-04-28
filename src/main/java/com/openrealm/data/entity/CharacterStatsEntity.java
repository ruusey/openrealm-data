package com.openrealm.data.entity;

import org.springframework.data.annotation.Id;
import org.springframework.data.annotation.TypeAlias;
import org.springframework.data.mongodb.core.mapping.Document;

import com.openrealm.game.data.GameDataManager;
import com.openrealm.game.model.CharacterClassModel;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.EqualsAndHashCode;
import lombok.NoArgsConstructor;

@Document("player_character_stats")
@TypeAlias("com.jrealm.data.entity.CharacterStatsEntity")
@NoArgsConstructor
@AllArgsConstructor
@Data
@Builder
@EqualsAndHashCode(callSuper=false)
public class CharacterStatsEntity extends TemporalEntity {
	private static final long serialVersionUID = 186218452080820122L;
	@Id
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
	// Opaque cosmetic dye id keyed in the client's dye-assets.json. See
	// CharacterStatsDto for the rationale. 0 / null = no dye.
	private Integer dyeId;

	public static CharacterStatsEntity characterDefaults(final Integer characterClass) {
		final CharacterClassModel model = GameDataManager.CHARACTER_CLASSES.get(characterClass);
		return CharacterStatsEntity.builder()
				.classId(characterClass)
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
